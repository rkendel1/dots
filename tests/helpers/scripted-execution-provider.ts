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

export interface ScriptedExecutionProviderOptions {
  /** Provider statuses to return, in the order they are polled. */
  script?: string[];
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
}

export class ScriptedExecutionProvider implements ExecutionProvider {
  readonly name = 'scripted-test';

  readonly started: ExecutionRequest[] = [];
  readonly cancelled: string[] = [];
  readonly idempotencyKeys: string[] = [];

  private readonly executions = new Map<string, ScriptedExecution>();
  private cursor = 0;
  private sequence = 0;

  constructor(
    private readonly options: ScriptedExecutionProviderOptions = {},
  ) {}

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
