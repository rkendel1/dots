/**
 * The execution provider boundary.
 *
 * This is the whole of what OpenDots knows about running work elsewhere. The
 * domain layer above it deals only in "asked, started, running, finished, gone
 * wrong"; everything below — wire formats, authentication, workload encoding,
 * status vocabularies — is the provider's problem and must not leak upward.
 *
 * It lives in `server/` rather than `shared/` on purpose: the browser must never
 * see a provider interface, a provider status word, or anything that would let a
 * provider's vocabulary reach the UI. The only thing that crosses into shared
 * territory is a normalized `ExecutionStatus`.
 */
import type { ExecutionStatus } from '../shared/types.js';

/** What OpenDots asks a provider to run. */
export interface ExecutionRequest {
  /**
   * The OpenDots execution id this request belongs to.
   *
   * Providers must treat this as opaque. It is OpenDots' identity, and it is what
   * makes a submission safe to repeat.
   */
  executionId: string;
  /**
   * The idempotency key to submit alongside the request.
   *
   * A provider that supports idempotent submission must send this, so that a
   * retry after a network timeout resolves to the execution it already started
   * instead of starting a second one.
   */
  idempotencyKey: string;
  /** The task this execution was requested for, when it came from one. */
  taskId?: string;
  /** The Dot this execution was requested for, when it came from one. */
  dotId?: string;
  /**
   * What to run, in OpenDots' own terms.
   *
   * Deliberately just a prompt and optional context: a provider is responsible
   * for turning this into whatever its interface accepts. No provider-specific
   * fields, and nothing that would let a future agent runtime leak in here.
   */
  input: {
    prompt: string;
    context?: unknown;
  };
}

/**
 * A provider's identity for an execution it accepted.
 *
 * This is what lets OpenDots ask about, cancel, or collect the result of an
 * execution in a *later* process — which is the whole point of an external
 * provider, and why it must be persisted rather than held in memory.
 */
export interface ExecutionHandle {
  /** The provider's own identifier, e.g. Compute's `job_id`. */
  providerExecutionId: string;
  /** The provider's session identity, when it ran inside one. */
  providerSessionId?: string;
}

/**
 * What a provider reports about an execution.
 *
 * `providerStatus` is the provider's own word, untranslated. Normalizing it is
 * the provider adapter's job, so the domain never learns a provider vocabulary.
 */
export interface ExecutionStatusReport {
  /** The provider's raw status, e.g. Compute's `waiting_for_capacity`. */
  providerStatus: string;
  /** Whether the provider considers the execution finished, successfully or not. */
  terminal: boolean;
  /** The provider's own failure explanation, when it gave one. */
  error?: { code?: string; message: string };
  /**
   * Whatever the execution produced, in the provider's own shape.
   *
   * Absent until the execution is terminal. Never synthesized: a provider that
   * only reports status leaves this undefined rather than inventing a payload.
   */
  result?: unknown;
  /** The provider's session identity, when it reports one. */
  providerSessionId?: string;
}

export interface ExecutionProvider {
  /** Stable name recorded on every execution this provider owns. */
  readonly name: string;

  /**
   * Ask the provider to start an execution.
   *
   * Must be safe to call twice with the same `idempotencyKey`. A second call
   * should resolve to the handle the first call produced, not create new work.
   */
  start(request: ExecutionRequest): Promise<ExecutionHandle>;

  /**
   * Ask the provider what became of an execution.
   *
   * This must remain answerable across an OpenDots restart, which is why it takes
   * a persisted {@link ExecutionHandle} rather than anything from this process.
   */
  getStatus(execution: ExecutionHandle): Promise<ExecutionStatusReport>;

  /**
   * Ask the provider for the result payload of a settled execution.
   *
   * Distinct from {@link ExecutionProvider.getStatus} because the two answer
   * different questions and are needed at different times: the status is read
   * while an execution is in flight, the result only once it has finished. Keeping
   * them separate is what lets a result that failed to download be retried later
   * without re-deciding a lifecycle that is already settled.
   *
   * A provider that has not published a result yet should throw
   * {@link ExecutionProviderError}; returning an empty payload would be a
   * fabricated result.
   */
  result(execution: ExecutionHandle): Promise<unknown>;

  /** Ask the provider to stop an execution, if it supports stopping. */
  cancel?(execution: ExecutionHandle): Promise<void>;

  /**
   * Ask the provider for the verifiable evidence of an execution.
   *
   * Optional because not every provider produces evidence, and because — as with
   * a result — it only exists once the execution has finished.
   *
   * The payload is returned **verbatim**, in the provider's own shape. OpenDots
   * does not model receipt fields: re-typing them would let an incompatible
   * provider change pass typechecking, which is precisely the failure a receipt
   * exists to prevent.
   *
   * A provider that has no receipt *yet* should throw
   * {@link ExecutionProviderError} rather than returning a placeholder. Callers
   * must treat "no receipt yet" as "ask again later", never as an execution
   * failure.
   */
  receipt?(execution: ExecutionHandle): Promise<unknown>;

  /**
   * Whether this provider can run work at all right now.
   *
   * Used to decide whether to offer the action, never to fabricate a result: a
   * provider that is not ready leaves the execution `queued`, never `completed`.
   */
  ready(): Promise<boolean>;
}

/**
 * A failure the provider reported, carrying the provider's own code.
 *
 * `code` is the provider's own error kind verbatim where one exists, so the
 * boundary can be asserted against rather than approximated.
 */
export class ExecutionProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionProviderError';
  }
}

/**
 * Compute's `JobStatus`, exactly as `compute-core` declares it.
 *
 * Every value is listed rather than pattern-matched, so that a Compute release
 * adding or renaming one fails {@link normalizeExecutionStatus} loudly instead of
 * silently mapping an unknown outcome onto a lifecycle state.
 */
const COMPUTE_JOB_STATUSES = [
  'created',
  'accepted',
  'queued',
  'waiting_for_capacity',
  'reserved',
  'admitted',
  'preparing',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'rejected',
] as const;

/**
 * Translate a provider status into the OpenDots lifecycle.
 *
 * Kept beside the provider boundary rather than in the domain so that the
 * normalization is auditable next to the vocabulary it translates, and so no
 * domain branch ever names a provider.
 *
 * The mapping is deliberately conservative:
 *
 *   - `succeeded` is the only success. An execution is never `completed` on the
 *     strength of a timeout or a provider reporting "terminal".
 *   - `timed_out` and `rejected` are failures the provider chose to distinguish,
 *     so they become `failed` but keep their own code for the record.
 *   - `created`…`reserved` are all still waiting for a worker, so they stay
 *     `queued`; `admitted` and `preparing` mean it is being set up.
 *   - A terminal status that is not one of the three known terminal outcomes is a
 *     failure, because an execution whose real outcome is unknown must never be
 *     reported as finished successfully.
 *
 * @throws when the provider reports a status this build does not recognize
 */
export function normalizeExecutionStatus(
  providerStatus: string,
  terminal: boolean,
): ExecutionStatus {
  const known = new Set<string>(COMPUTE_JOB_STATUSES);
  if (!known.has(providerStatus))
    throw new ExecutionProviderError(
      'provider',
      'unknown_status',
      `Execution provider reported an unrecognized status "${providerStatus}". ` +
        `Refusing to guess a lifecycle state for an execution whose real outcome ` +
        `is unknown.`,
    );
  switch (providerStatus as (typeof COMPUTE_JOB_STATUSES)[number]) {
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'rejected':
    case 'timed_out':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'admitted':
    case 'preparing':
      return 'starting';
    case 'running':
      return 'running';
    default:
      // `created`, `accepted`, `queued`, `waiting_for_capacity`, `reserved`.
      return terminal ? 'failed' : 'queued';
  }
}
