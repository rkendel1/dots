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
 * The service deliberately does not poll on a timer of its own. Recovery and
 * explicit refreshes are driven by the caller, so OpenDots introduces no
 * background infrastructure the Compute contract does not require.
 */
import type { Execution } from '../shared/types.js';
import {
  ExecutionProviderError,
  normalizeExecutionStatus,
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
      return (
        (await this.store.transition(starting.id, 'failed', {
          errorCode:
            error instanceof ExecutionProviderError
              ? error.code
              : 'transport_failure',
          error:
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
      })) ?? starting
    );
  }

  /**
   * Ask the provider what became of an execution and record the answer.
   *
   * The provider's word is normalized here, in the service, rather than inside
   * the provider, so that the table that maps one vocabulary onto another stays
   * auditable in one place.
   *
   * An execution the provider has never heard of is *not* assumed finished. It
   * is recorded as failed with the provider's own `unknown_job` code, because the
   * execution OpenDots believes in does not exist — and silently leaving it
   * `running` forever would be the worse lie.
   */
  async reconcile(execution: Execution): Promise<Execution> {
    if (!this.provider) return execution;
    if (isTerminal(execution.status)) return execution;
    if (!execution.providerExecutionId) {
      // Queued or starting, but the provider never gave us an identity. Either a
      // submission failed, or a previous process died between the two writes.
      if (execution.status === 'queued')
        return (await this.submit(execution)) ?? execution;
      return execution;
    }
    let report;
    try {
      report = await this.provider.getStatus({
        providerExecutionId: execution.providerExecutionId,
        ...(execution.providerSessionId
          ? { providerSessionId: execution.providerSessionId }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof ExecutionProviderError &&
        error.code === 'unknown_job'
      )
        return (
          (await this.store.transition(execution.id, 'failed', {
            providerStatus: execution.providerStatus,
            errorCode: 'unknown_job',
            error: error.message,
          })) ?? execution
        );
      // A transport failure says nothing about the execution's real state, so
      // nothing is written. Leaving it as it was is the honest outcome: a later
      // reconcile will try again.
      throw error;
    }
    const status = normalizeExecutionStatus(
      report.providerStatus,
      report.terminal,
    );
    // Polling an execution that has not moved must not be an error. When the
    // normalized status is unchanged the observation is still worth keeping — the
    // provider's exact word is part of the durable record — but the lifecycle
    // does not move, so it goes through `annotate` rather than `transition`.
    if (status === execution.status)
      return (
        (await this.store.annotate(execution.id, {
          providerStatus: report.providerStatus,
          ...(report.providerSessionId !== undefined
            ? { providerSessionId: report.providerSessionId }
            : {}),
        })) ?? execution
      );
    return (
      (await this.store.transition(execution.id, status, {
        providerStatus: report.providerStatus,
        ...(report.providerSessionId !== undefined
          ? { providerSessionId: report.providerSessionId }
          : {}),
        ...(status === 'completed' ? { result: report.result ?? null } : {}),
        ...(status === 'failed' || status === 'cancelled'
          ? {
              errorCode: report.error?.code ?? report.providerStatus,
              error: report.error?.message ?? null,
            }
          : {}),
      })) ?? execution
    );
  }

  /**
   * Reconcile every execution that has not finished.
   *
   * Called on startup, this is what makes an execution survive a restart: the
   * record is durable, and its real outcome is read back from the provider rather
   * than guessed from the fact that this is a new process.
   */
  async recover(): Promise<Execution[]> {
    const active = await this.store.active();
    const settled: Execution[] = [];
    for (const execution of active) {
      try {
        settled.push(await this.reconcile(execution));
      } catch {
        // The provider is unreachable. The execution stays exactly as recorded,
        // so the next reconcile — or the next restart — tries again.
        settled.push(execution);
      }
    }
    return settled;
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
