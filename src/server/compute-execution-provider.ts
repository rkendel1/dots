/**
 * `ComputeExecutionProvider` — OpenDots speaking Compute's real, published
 * execution interface.
 *
 * ## What this talks to
 *
 * Compute exposes `compute.remote@1`, a versioned HTTP protocol declared in
 * `compute-provider/src/lib.rs` (`REMOTE_PROTOCOL`) and served by `compute serve`
 * or by a node acting as a provider. This adapter uses only endpoints that
 * protocol actually declares:
 *
 * | Purpose               | Method + path                        |
 * | --------------------- | ------------------------------------ |
 * | readiness             | `GET  /compute/health`               |
 * | submit a durable job  | `POST /compute/jobs`                 |
 * | read status           | `GET  /compute/jobs/{id}`            |
 * | read the result       | `GET  /compute/jobs/{id}/result`     |
 * | read verifiable proof | `GET  /compute/jobs/{id}/receipt`    |
 * | cancel                | `POST /compute/jobs/{id}/cancel`     |
 *
 * Nothing here invents an endpoint. If Compute does not offer something, this
 * adapter does not pretend to.
 *
 * ## What this deliberately does not do
 *
 * `compute.remote@1` has no field for a natural-language prompt. Its request
 * carries an *artifact* — a workload to execute — and nothing else. OpenDots
 * therefore has to express a prompt as a workload, which is a genuine boundary and
 * is documented in `docs/EXECUTION-ARCHITECTURE.md` rather than papered over.
 *
 * It also does not start, supervise, discover, or install Compute. OpenDots is
 * given an endpoint and uses it; whether Compute is running, and what eventually
 * executes inside it, are Compute's business.
 */
import {
  ExecutionProviderError,
  normalizeExecutionStatus,
  type ExecutionHandle,
  type ExecutionProvider,
  type ExecutionRequest,
  type ExecutionStatusReport,
} from './execution-provider.js';

/** The protocol identifier Compute requires on every request. */
export const COMPUTE_PROTOCOL = 'compute.remote@1';

/** Compute's `WORKLOAD_SPEC_VERSION`. */
const WORKLOAD_SPEC_VERSION = '1';

/**
 * Compute's terminal `JobStatus` values.
 *
 * Read from `compute-core`: `is_terminal()` is true for exactly these five.
 */
const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'rejected',
]);

/** Compute's `JobId` is `job_` followed by a sha256 digest, lowercase hex. */
const JOB_ID = /^job_[0-9a-f]{64}$/;

export interface ComputeProviderOptions {
  /** Base URL of a Compute node serving `compute.remote@1`. */
  endpoint: string;
  /**
   * Value for the `Authorization` header.
   *
   * Omit for a provider that does not require it. OpenDots never manages
   * Compute's credentials; it is handed one, the same way it is handed an endpoint.
   */
  authorization?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** The JSON shape Compute returns for `POST /compute/jobs`. */
interface ComputeJobSubmission {
  job_id: string;
  request_id?: string;
  status: string;
}

/** The JSON shape Compute returns for `GET /compute/jobs/{id}`. */
interface ComputeExecutionJob {
  job_id: string;
  status: string;
  execution_id?: string | null;
  session_id?: string | null;
  failure?: string | null;
}

/** The JSON shape Compute returns for `GET /compute/jobs/{id}/result`. */
interface ComputeJobResult {
  job_id: string;
  status: string;
  result?: {
    execution_id?: string;
    exit_code?: number | null;
    stdout?: { text: string; truncated: boolean; bytes: number };
    stderr?: { text: string; truncated: boolean; bytes: number };
    error?: { message?: string; code?: string } | null;
    receipt?: unknown;
  };
}

/** Compute's own error envelope, as declared by `ProviderError`. */
interface ComputeProviderError {
  kind?: string;
  message?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The workload OpenDots sends when it wants a prompt executed.
 *
 * Compute's `ArtifactTransport::Inline` carries a `WorkloadSpec` plus the bytes of
 * its entrypoint. A prompt is not a program, so OpenDots wraps it in the smallest
 * honest program: a shell entrypoint that echoes the prompt and writes it to the
 * one declared output. Nothing here pretends the prompt is an instruction to a
 * language model — it is a payload the workload carries, and the result is
 * whatever that workload actually produced.
 */
function promptWorkload(prompt: string) {
  return {
    protocol: COMPUTE_PROTOCOL,
    artifact: {
      Inline: {
        workload: {
          version: WORKLOAD_SPEC_VERSION,
          runtime: 'shell',
          entrypoint: 'run.sh',
          args: [],
          env: { OPENDOTS_EXECUTION: '1' },
          inputs: [],
          outputs: [{ path: 'result.txt', required: true }],
          network: 'none',
        },
        // Compute's `bytes_json` accepts a UTF-8 string in place of a byte array,
        // so the prompt travels as text rather than base64.
        entrypoint: {
          path: 'run.sh',
          data: '#!/bin/sh\ncat prompt.txt > result.txt\n',
        },
        inputs: [
          {
            path: 'prompt.txt',
            data: prompt,
          },
        ],
      },
    },
    expected: {},
    execution: {},
  };
}

/**
 * Speaks `compute.remote@1` to one Compute node.
 *
 * The node is given, never discovered or started: OpenDots is handed an endpoint
 * and uses it. That keeps the dependency direction one-way, and keeps Compute's
 * lifecycle entirely Compute's business.
 */
export class ComputeExecutionProvider implements ExecutionProvider {
  readonly name = 'compute';

  private readonly base: string;
  private readonly authorization?: string;
  private readonly timeoutMs: number;

  constructor(options: ComputeProviderOptions) {
    this.base = options.endpoint.replace(/\/+$/, '');
    if (options.authorization) this.authorization = options.authorization;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * One `compute.remote@1` exchange.
   *
   * Compute's own client sends `X-Compute-Protocol` on every request and treats
   * any non-2xx as an error carrying a `ProviderError` envelope. This mirrors
   * that exactly, so a Compute change surfaces as a typed provider error rather
   * than a generic HTTP failure.
   */
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'X-Compute-Protocol': COMPUTE_PROTOCOL,
          ...(this.authorization ? { Authorization: this.authorization } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (controller.signal.aborted)
        throw new ExecutionProviderError(
          this.name,
          'transport_failure',
          `Compute did not answer ${method} ${path} within ${this.timeoutMs}ms.`,
        );
      throw new ExecutionProviderError(
        this.name,
        'transport_failure',
        `Could not reach Compute at ${this.base}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (!response.ok) {
      let envelope: ComputeProviderError | undefined;
      try {
        envelope = JSON.parse(text) as ComputeProviderError;
      } catch {
        // Compute did not answer with its own error shape; fall through.
      }
      throw new ExecutionProviderError(
        this.name,
        envelope?.kind ?? 'transport_failure',
        envelope?.message ?? `Compute returned HTTP ${response.status}.`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ExecutionProviderError(
        this.name,
        'transport_failure',
        `Compute returned an unreadable response to ${method} ${path}.`,
      );
    }
  }

  /**
   * Compute answers `unknown_job` when it has no record of the id.
   *
   * That is not a transport failure: the execution is simply not there, and the
   * domain needs to hear that distinction so it can say so instead of retrying
   * forever against an execution that will never exist.
   */
  private notFound(error: unknown): boolean {
    return (
      error instanceof ExecutionProviderError && error.code === 'unknown_job'
    );
  }

  async ready(): Promise<boolean> {
    try {
      await this.call('GET', '/compute/health');
      return true;
    } catch {
      // Readiness is advisory. A provider that cannot be reached right now has
      // not failed an execution; it simply has nowhere to put one yet.
      return false;
    }
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    // Compute rejects a key over 256 bytes or containing control characters with
    // `idempotency_conflict`. Checking here turns a provider round trip into a
    // local error and keeps the failure attributable to OpenDots.
    if (
      request.idempotencyKey.length === 0 ||
      request.idempotencyKey.length > 256 ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f\u007f]/.test(request.idempotencyKey)
    )
      throw new ExecutionProviderError(
        this.name,
        'idempotency_conflict',
        'The execution idempotency key must be 1–256 bytes with no control characters.',
      );
    const submission = await this.call<ComputeJobSubmission>(
      'POST',
      '/compute/jobs',
      promptWorkload(request.input.prompt),
      request.idempotencyKey,
    );
    if (!JOB_ID.test(submission.job_id))
      throw new ExecutionProviderError(
        this.name,
        'transport_failure',
        `Compute returned a malformed job identity: ${submission.job_id}`,
      );
    // Prove the status word is one this build understands before persisting it,
    // so a Compute rename fails loudly here rather than mid-reconciliation.
    normalizeExecutionStatus(
      submission.status,
      TERMINAL_JOB_STATUSES.has(submission.status),
    );
    return { providerExecutionId: submission.job_id };
  }

  async getStatus(execution: ExecutionHandle): Promise<ExecutionStatusReport> {
    const id = execution.providerExecutionId;
    if (!JOB_ID.test(id))
      throw new ExecutionProviderError(
        this.name,
        'unknown_job',
        `Refusing to ask Compute about a malformed job identity: ${id}`,
      );
    let job: ComputeExecutionJob;
    try {
      job = await this.call<ComputeExecutionJob>('GET', `/compute/jobs/${id}`);
    } catch (error) {
      if (this.notFound(error))
        throw new ExecutionProviderError(
          this.name,
          'unknown_job',
          `Compute has no record of execution ${id}.`,
        );
      throw error;
    }
    const terminal = TERMINAL_JOB_STATUSES.has(job.status);
    const report: ExecutionStatusReport = {
      providerStatus: job.status,
      terminal,
    };
    if (job.session_id) report.providerSessionId = job.session_id;
    // Compute's own explanation, when it gave one. Not reworded.
    if (job.failure) report.error = { code: job.status, message: job.failure };
    // The result is only read once the execution has actually finished. Asking
    // earlier would produce a provider error, not an empty result, and pretending
    // otherwise is exactly the fabrication this boundary exists to prevent.
    if (terminal) {
      // The result is read opportunistically and is deliberately allowed to be
      // missing. Evidence seals independently of the outcome: a job can be
      // `succeeded` for minutes before its result is published, and a receipt
      // longer still. Letting a sealed-but-unavailable result abort this read
      // would pin the execution in `running` forever — the very state it has
      // already left. So the status is reported regardless, and the missing
      // payload is left to the separate retrieval path, which retries and records
      // whatever actually goes wrong.
      try {
        const payload = await this.call<ComputeJobResult>(
          'GET',
          `/compute/jobs/${id}/result`,
        );
        if (payload.result) {
          report.result = payload.result;
          if (payload.result.error)
            report.error = {
              ...(payload.result.error.code
                ? { code: payload.result.error.code }
                : {}),
              message:
                payload.result.error.message ?? 'Compute reported a failure.',
            };
        }
      } catch {
        // Intentionally swallowed — see above. The result is fetched again, and
        // surfaced, by `ExecutionReconciler.collectEvidence`.
      }
    }
    return report;
  }

  /**
   * Read the result payload from `GET /compute/jobs/{id}/result`.
   *
   * Returns Compute's `JobResult.result` — the `ExecutionResult` — verbatim. The
   * OpenDots record already carries the provider job id, and re-modelling
   * Compute's result schema would only create a second place for it to drift.
   *
   * A job with no result yet is answered by Compute with `unknown_job` or
   * `job_expired`; both are propagated unchanged so the caller can tell "no result
   * yet" from "this node is unreachable".
   */
  async result(execution: ExecutionHandle): Promise<unknown> {
    const id = execution.providerExecutionId;
    if (!JOB_ID.test(id))
      throw new ExecutionProviderError(
        this.name,
        'unknown_job',
        `Refusing to read a result for a malformed job identity: ${id}`,
      );
    const payload = await this.call<ComputeJobResult>(
      'GET',
      `/compute/jobs/${id}/result`,
    );
    if (!payload.result)
      throw new ExecutionProviderError(
        this.name,
        'unknown_job',
        `Compute has not published a result for ${id} yet.`,
      );
    return payload.result;
  }

  async cancel(execution: ExecutionHandle): Promise<void> {
    const id = execution.providerExecutionId;
    if (!JOB_ID.test(id))
      throw new ExecutionProviderError(
        this.name,
        'unknown_job',
        `Refusing to cancel a malformed job identity: ${id}`,
      );
    await this.call('POST', `/compute/jobs/${id}/cancel`);
  }

  /**
   * Read the execution receipt from `GET /compute/jobs/{id}/receipt`.
   *
   * The envelope Compute returns is `JobReceipt { job_id, receipt }`. It is
   * stored whole, so the job id travels with the evidence and a receipt can be
   * correlated to the execution that produced it without trusting the field
   * OpenDots happens to have recorded.
   *
   * **A contract nuance this has to respect.** Compute reports a receipt that
   * does not exist *yet* as `ProviderErrorKind::RemoteExecutionFailure` with the
   * message "job receipt is not available" — there is no distinct "not ready"
   * kind. So this method re-labels that one case as `receipt_unavailable`, and
   * leaves every other error exactly as Compute reported it. Without that, a
   * receipt that had not been sealed yet would be indistinguishable from a
   * genuinely broken one, and reconciliation would either retry forever or give
   * up on evidence that was simply early.
   */
  async receipt(execution: ExecutionHandle): Promise<unknown> {
    const id = execution.providerExecutionId;
    if (!JOB_ID.test(id))
      throw new ExecutionProviderError(
        this.name,
        'unknown_job',
        `Refusing to read a receipt for a malformed job identity: ${id}`,
      );
    try {
      return await this.call('GET', `/compute/jobs/${id}/receipt`);
    } catch (error) {
      if (
        error instanceof ExecutionProviderError &&
        error.code === 'remote_execution_failure' &&
        /receipt is not available/i.test(error.message)
      )
        throw new ExecutionProviderError(
          this.name,
          'receipt_unavailable',
          'Compute has not published a receipt for this execution yet.',
        );
      throw error;
    }
  }
}

/**
 * Build a Compute provider from the environment.
 *
 * Returns `undefined` when no endpoint is configured, which is the normal case:
 * OpenDots must start, run and be fully usable without Compute present, because
 * Compute — and therefore the agent runtime behind it — is released separately.
 * There is deliberately no default endpoint and no discovery: if nothing is
 * configured, OpenDots has no execution provider, and says so.
 */
export function computeProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ComputeExecutionProvider | undefined {
  const endpoint = env.COMPUTE_ENDPOINT?.trim();
  if (!endpoint) return undefined;
  return new ComputeExecutionProvider({
    endpoint,
    ...(env.COMPUTE_AUTHORIZATION?.trim()
      ? { authorization: env.COMPUTE_AUTHORIZATION.trim() }
      : {}),
  });
}
