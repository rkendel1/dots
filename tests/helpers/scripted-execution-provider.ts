/**
 * `ScriptedExecutionProvider` — **test infrastructure only**.
 *
 * This is not Compute, and it is not Chip. It exists because Compute is released
 * independently and this suite must be green while it is still being built. It
 * simulates the lifecycle an execution goes through so the *domain* can be tested
 * without a Compute node.
 *
 * ## Why it cannot masquerade as either
 *
 *   - Its name is `scripted-test`, never `compute`. Every execution it owns
 *     records that name, so a scripted execution is visible as scripted in the
 *     durable record, the API and the UI.
 *   - It is constructed only by tests, from this file, which lives under `tests/`
 *     and is excluded from the published package by the `files` allowlist in
 *     `package.json`. It is not reachable from `src/`.
 *   - `computeProviderFromEnv` reads exactly one variable, `COMPUTE_ENDPOINT`, and
 *     builds exactly one provider. There is no environment path — and no default —
 *     that can select this one. Production configuration *cannot* reach it.
 *
 * ## What it deliberately does not do
 *
 * It reports the provider statuses it is told to report and nothing more. It does
 * not fabricate a result payload, a receipt, or a provider identity in Compute's
 * `job_…` format. Tests that need those assert them against {@link
 * ComputeExecutionProvider} with a stubbed transport instead.
 */
import {
  ExecutionProviderError,
  type ExecutionHandle,
  type ExecutionProvider,
  type ExecutionRequest,
  type ExecutionStatusReport,
} from '../../src/server/execution-provider.js';

interface ScriptedExecution {
  handle: ExecutionHandle;
  idempotencyKey: string;
  providerStatus: string;
  terminal: boolean;
  result?: unknown;
  error?: { code?: string; message: string };
}

/**
 * The set of jobs a scripted "Compute node" knows about.
 *
 * Exported so a test can model one node across several provider instances, which
 * is what a restart or a brief outage actually looks like: the node keeps its
 * jobs, and OpenDots is the side that lost its memory.
 */
export type ScriptedJobTable = Map<string, ScriptedExecution>;

export interface ScriptedExecutionProviderOptions {
  /** Provider statuses to return, in the order they are polled. */
  script?: string[];
  /**
   * Share one job table across instances.
   *
   * Models "the same Compute node, seen again" — a restart, or a provider that
   * was briefly unreachable and is now back. Without this, a freshly constructed
   * provider would report `unknown_job` for work a previous instance accepted,
   * which is exactly what a real node never does. Each instance keeps its own
   * script; only the record of *which jobs exist* is shared.
   */
  sharedTable?: ScriptedJobTable;
  /** Result attached when the script reaches a terminal status. */
  result?: unknown;
  /** Failure attached when the script reaches a terminal status. */
  error?: { code?: string; message: string };
  /** Throw from `start` instead of accepting, to test submission failure. */
  failStart?: { code: string; message: string };
  /** Report every execution as unknown to the provider. */
  forget?: boolean;
  /** Answer `ready()` with false. */
  unavailable?: boolean;
  /** Omit `cancel`, to test a provider that cannot stop work. */
  cannotCancel?: boolean;
  /**
   * Throw from every read as though the provider were unreachable.
   *
   * This is the outage double: the execution's real state is untouched, which is
   * exactly what a reconciliation pass must not be able to overwrite.
   */
  offline?: { code?: string; message?: string } | boolean;
  /** A receipt to serve. Omit to serve none at all. */
  receiptPayload?: unknown;
  /** Serve a receipt that is not published yet, as Compute does. */
  receiptNotPublished?: boolean;
  /** Withhold the result, as a provider that has not published it yet would. */
  resultNotPublished?: boolean;
}

export class ScriptedExecutionProvider implements ExecutionProvider {
  readonly name = 'scripted-test';

  readonly started: ExecutionRequest[] = [];
  readonly cancelled: string[] = [];
  readonly idempotencyKeys: string[] = [];

  private readonly executions: ScriptedJobTable;
  private cursor = 0;
  private sequence = 0;

  constructor(private readonly options: ScriptedExecutionProviderOptions = {}) {
    this.executions = options.sharedTable ?? new Map();
  }

  async ready(): Promise<boolean> {
    return !this.options.unavailable;
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    this.started.push(request);
    this.idempotencyKeys.push(request.idempotencyKey);
    if (this.options.failStart)
      throw new ExecutionProviderError(
        this.name,
        this.options.failStart.code,
        this.options.failStart.message,
      );
    // A retry of the same request resolves to the execution this provider already
    // accepted, exactly as a real idempotent provider must.
    const existing = [...this.executions.values()].find(
      (entry) => entry.idempotencyKey === request.idempotencyKey,
    );
    if (existing) return existing.handle;
    const handle: ExecutionHandle = {
      // Deliberately not a Compute `job_…` identity: nothing here should be
      // mistaken for something a real Compute node issued.
      providerExecutionId: `scripted-${++this.sequence}`,
    };
    this.executions.set(handle.providerExecutionId, {
      handle,
      idempotencyKey: request.idempotencyKey,
      providerStatus: 'accepted',
      terminal: false,
    });
    return handle;
  }

  async getStatus(execution: ExecutionHandle): Promise<ExecutionStatusReport> {
    this.guardOnline();
    const entry = this.executions.get(execution.providerExecutionId);
    if (!entry || this.options.forget)
      throw new ExecutionProviderError(
        this.name,
        'unknown_job',
        `The scripted provider has no record of ${execution.providerExecutionId}.`,
      );
    const script = this.options.script;
    if (script?.length) {
      // Advance on every poll, the way a real provider's status progresses over
      // time. The last entry repeats once reached, so a test that polls more
      // than the script is long sees a stable final state rather than nothing.
      const next = script[Math.min(this.cursor, script.length - 1)]!;
      this.cursor++;
      entry.providerStatus = next;
      entry.terminal = isTerminalWord(next);
      if (entry.terminal) {
        if (this.options.result !== undefined)
          entry.result = this.options.result;
        if (this.options.error) entry.error = this.options.error;
      }
    }
    return {
      providerStatus: entry.providerStatus,
      terminal: entry.terminal,
      ...(entry.result !== undefined ? { result: entry.result } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  /**
   * Refuse every read while `offline`, with the provider's own failure shape.
   *
   * Deliberately not `unknown_job`: an outage must be distinguishable from the
   * provider answering "no such job", because reconciliation treats them
   * completely differently.
   */
  private guardOnline(): void {
    if (!this.options.offline) return;
    const {
      code = 'transport_failure',
      message = 'The scripted provider is unreachable.',
    } = this.options.offline === true ? {} : this.options.offline;
    throw new ExecutionProviderError(this.name, code, message);
  }

  /**
   * Serve the published result, or refuse the way a provider with nothing
   * published yet must.
   *
   * Returning `null` here would be the double of fabricating evidence: the
   * reconciler would record `resultRetrieved: true` for a result nobody produced,
   * and any evidence-pending attention would clear on a lie. So an absent result
   * is an error, exactly as it is in the real adapter.
   */
  async result(execution: ExecutionHandle): Promise<unknown> {
    this.guardOnline();
    const entry = this.executions.get(execution.providerExecutionId);
    const published = entry?.result ?? this.options.result;
    if (!entry || this.options.resultNotPublished || published === undefined)
      throw new ExecutionProviderError(
        this.name,
        'result_not_published',
        `The scripted provider has not published a result for ${execution.providerExecutionId}.`,
      );
    return published;
  }

  /**
   * Serve a receipt, or refuse the way Compute does when one is not sealed yet.
   *
   * The "not published" case uses the same `receipt_unavailable` code the real
   * adapter produces, so reconciliation is exercised against the code it will
   * actually see in production rather than a test-only invention.
   */
  async receipt(_execution: ExecutionHandle): Promise<unknown> {
    this.guardOnline();
    if (
      this.options.receiptNotPublished ||
      this.options.receiptPayload === undefined
    )
      throw new ExecutionProviderError(
        this.name,
        'receipt_unavailable',
        'The scripted provider has not published a receipt yet.',
      );
    return this.options.receiptPayload;
  }

  async cancel(execution: ExecutionHandle): Promise<void> {
    if (this.options.cannotCancel)
      throw new ExecutionProviderError(
        this.name,
        'operation_unsupported',
        'The scripted provider cannot cancel an execution.',
      );
    this.cancelled.push(execution.providerExecutionId);
    const entry = this.executions.get(execution.providerExecutionId);
    if (entry) {
      entry.providerStatus = 'cancelled';
      entry.terminal = true;
    }
  }
}

function isTerminalWord(status: string): boolean {
  return ['succeeded', 'failed', 'cancelled', 'timed_out', 'rejected'].includes(
    status,
  );
}
