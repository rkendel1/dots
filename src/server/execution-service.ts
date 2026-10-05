/**
 * `ExecutionService` — the OpenDots-side execution control layer.
 *
 * This is the only thing that talks to both the durable domain and an
 * {@link ExecutionProvider}. It owns the order of operations that make an
 * external execution safe to retry and safe to lose:
 *
 * 1. **Durable intent first.** An execution is written to FeltDB as `queued`
 *    *before* the provider is contacted. If the process dies mid-request, the
 *    intent survives and recovery picks it up; the opposite order would leave a
 *    Compute job running that OpenDots has no record of.
 * 2. **Idempotent submission.** The provider is asked with the execution's
 *    idempotency key, so a retry after a timeout resolves to the job Compute
 *    already has instead of starting a second one.
 * 3. **Reconciliation, never assumption.** OpenDots never infers that an
 *    execution finished because it restarted. It asks the provider, and only
 *    applies what the provider says.
 *
 * The service deliberately does not poll. Reconciliation is
 * {@link ExecutionReconciler}'s job, because bringing OpenDots' view back into
 * agreement with the provider is a separate concern from asking for work: it has
 * its own schedule, its own failure semantics, and its own state.
 */
import type { Execution } from '../shared/types.js';
import {
  ExecutionProviderError,
  type ExecutionHandle,
  type ExecutionProvider,
} from './execution-provider.js';
import { ExecutionStore, isTerminal } from './executions.js';

export class NoExecutionProvider extends Error {
  constructor() {
    super(
      'No execution provider is configured. Set COMPUTE_ENDPOINT to the URL of a ' +
        'Compute node serving compute.remote@1.',
    );
    this.name = 'NoExecutionProvider';
  }
}

export interface RequestExecutionInput {
  taskId?: string | null;
  dotId?: string | null;
  prompt: string;
  /**
   * The key identifying *this request*, stable across retries of it.
   *
   * The API generates one per user action and returns it, so a client that times
   * out and retries gets the same execution back rather than a second one.
   */
  idempotencyKey: string;
}

export class ExecutionService {
  constructor(
    private readonly store: ExecutionStore,
    private readonly provider?: ExecutionProvider,
  ) {}

  /**
   * The durable execution record, for callers that only read.
   *
   * Exposed so the routes can answer "what does OpenDots believe?" without
   * contacting a provider. Every *change* still goes through this service, so
   * exposing the reader does not widen what a caller can mutate.
   */
  get executions(): ExecutionStore {
    return this.store;
  }

  /** Whether work can be submitted at all, without contacting the provider. */
  get configured(): boolean {
    return this.provider !== undefined;
  }

  /** The provider's name, for the API to report alongside the execution list. */
  get providerName(): string | undefined {
    return this.provider?.name;
  }

  /**
   * Record the intent, then ask the provider to run it.
   *
   * Returns the execution and whether this call created it. A caller that sees
   * `created: false` is looking at the execution an earlier attempt produced —
   * which is the correct, and only, answer to a retry.
   *
   * @throws {NoExecutionProvider} when nothing is configured
   * @throws {ExecutionProviderError} when the provider rejects the request; the
   *         execution is left `failed` with the provider's own code rather than
   *         silently dropped
   */
  async request(input: RequestExecutionInput): Promise<{
    execution: Execution;
    created: boolean;
  }> {
    if (!this.provider) throw new NoExecutionProvider();
    const { execution, created } = await this.store.create({
      taskId: input.taskId ?? null,
      dotId: input.dotId ?? null,
      provider: this.provider.name,
      prompt: input.prompt,
      idempotencyKey: input.idempotencyKey,
    });
    // An execution this key already produced has already been submitted, or is
    // being reconciled. Submitting again is harmless (the key makes it so) but
    // unnecessary, and skipping it keeps a retry cheap.
    if (!created) return { execution, created };
    return { execution: await this.submit(execution), created };
  }

  /** Move `queued → starting`, then ask the provider to start the work. */
  private async submit(execution: Execution): Promise<Execution> {
    const starting = await this.store.transition(execution.id, 'starting');
    if (!starting) return (await this.store.get(execution.id)) ?? execution;
    let handle: ExecutionHandle;
    try {
      handle = await this.provider!.start({
        executionId: starting.id,
        idempotencyKey: starting.idempotencyKey,
        ...(starting.taskId ? { taskId: starting.taskId } : {}),
        ...(starting.dotId ? { dotId: starting.dotId } : {}),
        input: { prompt: starting.prompt },
      });
    } catch (error) {
      // A definitive refusal is the provider answering, and retrying will not
      // change it. A transport failure is not: the provider was never asked, so
      // the execution is left `starting` with the failure recorded, and the
      // reconciler finishes the submission when the provider returns.
      const definitive =
        error instanceof ExecutionProviderError &&
        error.code !== 'transport_failure';
      if (definitive)
        return (
          (await this.store.transition(starting.id, 'failed', {
            errorCode: error.code,
            error: error.message,
          })) ?? starting
        );
      return (
        (await this.store.annotate(starting.id, {
          reconciliationErrorCode: 'transport_failure',
          reconciliationError:
            error instanceof Error
              ? error.message
              : 'The execution provider could not be reached.',
        })) ?? starting
      );
    }
    return (
      (await this.store.transition(starting.id, 'running', {
        providerExecutionId: handle.providerExecutionId,
        providerSessionId: handle.providerSessionId ?? null,
        lastReconciledAt: Date.now(),
      })) ?? starting
    );
  }

  /**
   * Ask the provider to stop an execution, then record the intent.
   *
   * The transition to `cancelled` happens only after the provider accepted the
   * request. A provider that cannot cancel leaves the execution running and the
   * error visible, rather than telling the user work stopped when it may not have.
   */
  async cancel(execution: Execution): Promise<Execution> {
    if (!this.provider) throw new NoExecutionProvider();
    if (isTerminal(execution.status)) return execution;
    if (!this.provider.cancel)
      throw new ExecutionProviderError(
        this.provider.name,
        'operation_unsupported',
        `The ${this.provider.name} execution provider cannot cancel an execution.`,
      );
    if (execution.providerExecutionId)
      await this.provider.cancel({
        providerExecutionId: execution.providerExecutionId,
        ...(execution.providerSessionId
          ? { providerSessionId: execution.providerSessionId }
          : {}),
      });
    return (
      (await this.store.transition(execution.id, 'cancelled')) ?? execution
    );
  }
}
