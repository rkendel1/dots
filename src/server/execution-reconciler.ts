/**
 * `ExecutionReconciler` — the durable execution control loop.
 *
 * OpenDots records what it *asked* for; Compute records what actually *happened*.
 * Those two only agree after somebody compares them, and until then OpenDots'
 * view is a belief rather than a fact. This class is that comparison, run
 * repeatedly, so the belief converges on the fact.
 *
 * ## The rules it exists to enforce
 *
 * 1. **Compute is authoritative.** A lifecycle state only ever moves because the
 *    provider said so. OpenDots never completes an execution because it asked
 *    Compute to, and never fails one because it could not reach Compute.
 * 2. **A communication failure is not an execution failure.** If
 *    `GET /compute/jobs/{id}` times out, the execution keeps its last known
 *    state, the failed attempt is recorded, and the next cycle tries again. The
 *    execution's fate is not OpenDots' connectivity.
 * 3. **Unknown provider states fail closed.** A status this build does not
 *    recognise is recorded verbatim and changes nothing. It is never rounded to
 *    success, and it never needs a new terminal state to absorb it.
 * 4. **Everything needed is durable.** The work list comes from FeltDB every
 *    cycle. There is no in-memory registry, queue, or timer that correctness
 *    depends on — a process that dies mid-cycle loses nothing but the cycle
 *    itself, and the next one re-derives the whole list.
 *
 * ## Concurrency
 *
 * Two reconcilers on the same execution are resolved by FeltDB's optimistic
 * fence, not by a process-global lock: both read version *n*, both attempt
 * version *n+1*, one commits and the other is refused and re-reads. A
 * `ExecutionStore.annotate` on an already-terminal record is refused outright,
 * which is what stops a slow pass from writing a stale observation over an
 * outcome another pass already settled.
 */
import type { Execution } from '../shared/types.js';
import {
  ExecutionProviderError,
  normalizeExecutionStatus,
  type ExecutionHandle,
  type ExecutionProvider,
} from './execution-provider.js';
import { ExecutionStore, isTerminal } from './executions.js';

/** What one reconciliation cycle did. Reported, not persisted. */
export interface ReconcileSummary {
  /** Non-terminal executions considered. */
  considered: number;
  /** Observations recorded with no lifecycle movement. */
  unchanged: number;
  /** Executions that moved to a new lifecycle state. */
  advanced: number;
  /** Executions the provider could not be asked about. */
  unreachable: number;
  /** Executions the provider reported a state this build cannot interpret. */
  unsupported: number;
  /** Terminal executions back-filled with a result or receipt. */
  retrieved: number;
}

const emptySummary = (): ReconcileSummary => ({
  considered: 0,
  unchanged: 0,
  advanced: 0,
  unreachable: 0,
  unsupported: 0,
  retrieved: 0,
});

function errorCode(error: unknown): string {
  return error instanceof ExecutionProviderError
    ? error.code
    : 'transport_failure';
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The execution provider could not be reached.';
}

/**
 * Whether an error means "the evidence is not sealed yet" rather than "something
 * went wrong".
 *
 * The two must not be conflated. A provider that has finished but has not
 * published a result is behaving correctly and will publish one shortly;
 * recording that as a reconciliation error would make ordinary latency look like
 * an outage, and would trip the provider-unreachable attention rule on a perfectly
 * healthy node.
 */
function isPendingEvidence(error: unknown): boolean {
  return (
    error instanceof ExecutionProviderError &&
    (error.code === 'receipt_unavailable' ||
      error.code === 'result_not_published')
  );
}

export interface ReconcilerOptions {
  /** How often to reconcile, in milliseconds. */
  intervalMs?: number;
  /**
   * Run after every cycle, once execution state has settled.
   *
   * This is how attention gets generated. There is deliberately no second
   * polling loop: the reconciler already discovers authoritative changes from
   * FeltDB every cycle, and a separate loop would either duplicate that work or
   * disagree with it about what is true. Passing `undefined` disables attention
   * entirely, which is how a deployment with no provider still runs.
   *
   * A throw here is swallowed and reported through {@link onCycleError}: a
   * control-plane failure must never stop execution reconciliation, or a broken
   * attention rule could freeze real work.
   */
  onCycleComplete?: (input: { executions: Execution[] }) => Promise<unknown>;
  /** Reported when a cycle throws, so failures are visible without a logger. */
  onCycleError?: (error: unknown) => void;
}

export const DEFAULT_RECONCILE_INTERVAL_MS = 15_000;

export class ExecutionReconciler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<ReconcileSummary>;
  private lastCycleAt: number | null = null;

  constructor(
    private readonly store: ExecutionStore,
    private readonly provider?: ExecutionProvider,
    private readonly options: ReconcilerOptions = {},
  ) {}

  /** Whether a cycle can run at all. */
  get configured(): boolean {
    return this.provider !== undefined;
  }

  /** When the last cycle finished. Process state, reported for diagnostics only. */
  get lastRunAt(): number | null {
    return this.lastCycleAt;
  }

  /**
   * Reconcile every outstanding execution, then back-fill missing evidence.
   *
   * Safe to call at any time and from anywhere: a cycle already running is
   * joined rather than started a second time, so a slow provider cannot cause
   * overlapping passes over the same execution.
   */
  async reconcileAll(): Promise<ReconcileSummary> {
    this.inFlight ??= this.cycle().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async cycle(): Promise<ReconcileSummary> {
    const summary = emptySummary();
    // Not an early return: with no provider there is nothing to reconcile, but
    // tasks still reach states that need a human, and attention must be derived
    // from every durable record rather than only the ones Compute produced.
    if (this.provider) {
      try {
        // The work list is re-derived from durable state every cycle. Nothing here
        // remembers an execution between passes.
        for (const execution of await this.store.active()) {
          summary.considered++;
          try {
            await this.reconcileOne(execution);
          } catch (error) {
            // One execution must never abort the cycle; the rest still deserve a
            // chance to be brought into agreement.
            summary.unreachable++;
            this.options.onCycleError?.(error);
          }
        }
        for (const execution of await this.store.pendingRetrievals()) {
          try {
            if (await this.collectEvidence(execution)) summary.retrieved++;
          } catch (error) {
            this.options.onCycleError?.(error);
          }
        }
      } catch (error) {
        this.options.onCycleError?.(error);
      } finally {
        this.lastCycleAt = Date.now();
      }
    } else {
      this.lastCycleAt = Date.now();
    }
    // Attention is evaluated from the state this cycle *settled*, not from what it
    // was asked about, so a half-finished pass never generates an item for a
    // condition that has already cleared.
    await this.evaluateAttention();
    return summary;
  }

  /**
   * Let the control plane interpret the state this cycle produced.
   *
   * Reads the execution list again rather than reusing the loop's, so what is
   * evaluated is exactly what a later API read would see.
   */
  private async evaluateAttention(): Promise<void> {
    if (!this.options.onCycleComplete) return;
    try {
      await this.options.onCycleComplete({
        executions: await this.store.list(),
      });
    } catch (error) {
      this.options.onCycleError?.(error);
    }
  }

  /**
   * Bring one execution into agreement with the provider.
   *
   * Exposed so a single execution can be reconciled on demand — when a user
   * presses refresh, or when an API read wants a current answer — without
   * waiting for the next cycle.
   */
  async reconcileOne(execution: Execution): Promise<Execution> {
    // Terminal is terminal. A repeated pass over finished work is a no-op, which
    // is what makes reconciliation idempotent.
    if (!this.provider || isTerminal(execution.status)) return execution;
    if (!execution.providerExecutionId) {
      // No provider identity yet. Either this never left `queued`, or a previous
      // process died between recording the intent and recording the handle.
      // Submitting again is safe precisely because the request is idempotent:
      // Compute resolves the same key to the job it already has, or creates one.
      return this.submit(execution);
    }
    return this.observe(execution, {
      providerExecutionId: execution.providerExecutionId,
      ...(execution.providerSessionId
        ? { providerSessionId: execution.providerSessionId }
        : {}),
    });
  }

  /**
   * Ask the provider about an execution and record what it said.
   *
   * Every exit from here either moves the lifecycle to something the provider
   * reported, or leaves it exactly where it was. There is no third option.
   */
  private async observe(
    execution: Execution,
    handle: ExecutionHandle,
  ): Promise<Execution> {
    const now = Date.now();
    let report;
    try {
      report = await this.provider!.getStatus(handle);
    } catch (error) {
      return this.afterFailedObservation(execution, error);
    }

    let status;
    try {
      status = normalizeExecutionStatus(report.providerStatus, report.terminal);
    } catch (error) {
      // Fail closed. The raw word is recorded so an operator can see exactly what
      // Compute said, and the lifecycle does not move at all — an interpretation
      // OpenDots cannot make is not a state it may invent.
      return (
        (await this.store.annotate(execution.id, {
          providerStatus: report.providerStatus,
          reconciliationErrorCode: 'unknown_status',
          reconciliationError: errorMessage(error),
        })) ?? execution
      );
    }

    const observation = {
      providerStatus: report.providerStatus,
      lastReconciledAt: now,
      // A successful observation clears whatever the last failed attempt left
      // behind, so a recovered provider stops looking like an outage.
      reconciliationErrorCode: null,
      reconciliationError: null,
      ...(report.providerSessionId !== undefined
        ? { providerSessionId: report.providerSessionId }
        : {}),
    };

    if (status === execution.status) {
      // Same lifecycle state: this is an observation, not a transition. The
      // transition table stays strict — `running → running` is not a lifecycle
      // event, and pretending otherwise would make the table unreadable.
      return (
        (await this.store.annotate(execution.id, observation)) ?? execution
      );
    }

    if (status === 'completed') {
      // `resultRetrieved` is decided by whether a payload actually came back,
      // never by the status alone. A completion whose result has not arrived is
      // `completed` with nothing to show, and the record says so; `collectEvidence`
      // will fill it in.
      const settled = await this.store.transition(execution.id, 'completed', {
        ...observation,
        result: report.result ?? null,
        resultRetrieved: report.result !== undefined,
      });
      return this.afterSettle(settled, execution);
    }

    if (status === 'failed' || status === 'cancelled') {
      const settled = await this.store.transition(execution.id, status, {
        ...observation,
        errorCode: report.error?.code ?? report.providerStatus,
        error: report.error?.message ?? null,
      });
      return this.afterSettle(settled, execution);
    }

    return (
      (await this.store.transition(execution.id, status, observation)) ??
      (await this.current(execution))
    );
  }

  /**
   * The authoritative record after a lifecycle move.
   *
   * Two things matter here, and both were real bugs before they were handled:
   *
   *   - A transition that did not apply — because another pass settled the
   *     execution first — must return what is *actually* stored, not the copy this
   *     pass started from. Handing back the stale copy would report a stale status
   *     to the caller.
   *   - Evidence collected immediately afterwards must be visible in the returned
   *     record, or a caller would see a completed execution whose receipt it does
   *     not yet know about.
   */
  private async afterSettle(
    settled: Execution | undefined,
    before: Execution,
  ): Promise<Execution> {
    const current = settled ?? (await this.current(before));
    if (settled) await this.collectEvidence(settled);
    return await this.current(current);
  }

  /** Re-read an execution, preferring durable state over a caller's snapshot. */
  private async current(execution: Execution): Promise<Execution> {
    return (await this.store.get(execution.id)) ?? execution;
  }

  /**
   * What to do when the provider could not be asked.
   *
   * The distinction that matters is between *the provider answered, and the
   * answer is "no such job"* and *the provider did not answer*.
   *
   *   - `unknown_job` is a statement: Compute has no record of this job, so the
   *     execution OpenDots believes in cannot exist. That is a real outcome and
   *     the execution is failed with Compute's own code.
   *   - Everything else — a timeout, a refused connection, an unauthorized node,
   *     an unsupported operation — says nothing at all about the execution's
   *     fate. The lifecycle is left exactly where it was, the failed attempt is
   *     recorded so the outage is visible, and the next cycle tries again.
   *
   * Turning a network blip into `running → failed` would be the worst possible
   * answer: it would report a failure the provider never reported, and lose the
   * execution's real outcome.
   */
  private async afterFailedObservation(
    execution: Execution,
    error: unknown,
  ): Promise<Execution> {
    if (error instanceof ExecutionProviderError && error.code === 'unknown_job')
      return (
        (await this.store.transition(execution.id, 'failed', {
          errorCode: 'unknown_job',
          error: error.message,
          lastReconciledAt: Date.now(),
        })) ?? execution
      );
    return (
      (await this.store.annotate(execution.id, {
        reconciliationErrorCode: errorCode(error),
        reconciliationError: errorMessage(error),
      })) ?? execution
    );
  }

  /**
   * Fill in the result and receipt of an execution that has already settled.
   *
   * Separate from the status pass because it is a genuinely different problem:
   * the outcome is known and cannot change, but the evidence attached to it may
   * not have been sealed yet. An execution whose result failed to download stays
   * discoverable in `pendingRetrievals()` until it is fetched — including across
   * a restart, because the "still needed" decision is derived from durable
   * fields rather than remembered.
   *
   * Never moves the lifecycle. A failure here is recorded as a reconciliation
   * error, not as an execution failure.
   *
   * @returns whether anything was actually retrieved
   */
  private async collectEvidence(execution: Execution): Promise<boolean> {
    if (!this.provider) return false;
    if (isTerminal(execution.status) === false) return false;
    const handleId = execution.providerExecutionId;
    if (!handleId) return false;
    if (execution.resultRetrieved && execution.receipt !== null) return false;
    const handle: ExecutionHandle = {
      providerExecutionId: handleId,
      ...(execution.providerSessionId
        ? { providerSessionId: execution.providerSessionId }
        : {}),
    };
    const patch: Parameters<ExecutionStore['annotate']>[1] = {};
    // Whether a payload actually arrived. A write that only recorded a retrieval
    // failure is not a retrieval, and the cycle summary must not count it as one.
    let retrieved = false;

    if (!execution.resultRetrieved) {
      try {
        patch.result = await this.provider.result(handle);
        patch.resultRetrieved = true;
        retrieved = true;
      } catch (error) {
        // The outcome is already recorded and will not change, so a result that has
        // not arrived is *pending evidence*, not a failure to observe. Recorded the
        // same way an unsealed receipt is: visible, retryable, and explicitly not
        // an error — which is what stops ordinary latency from looking like an
        // outage and tripping the provider-unreachable rule on a healthy node.
        if (!isPendingEvidence(error)) {
          patch.reconciliationErrorCode = errorCode(error);
          patch.reconciliationError = errorMessage(error);
        }
      }
    }

    if (execution.receipt === null && this.provider.receipt) {
      try {
        patch.receipt = await this.provider.receipt(handle);
        retrieved = true;
      } catch (error) {
        // A receipt that has not been sealed yet is expected. It is recorded as
        // pending and retried within the grace window; it never touches the
        // lifecycle, which `annotate` cannot do anyway.
        if (!(
          error instanceof ExecutionProviderError &&
          error.code === 'receipt_unavailable'
        ))
          patch.reconciliationErrorCode = errorCode(error);
      }
    }

    if (Object.keys(patch).length === 0) return false;
    // The *execution's* id, not the provider's — these are different identities,
    // and the store is keyed by OpenDots' own.
    const written = await this.store.recordEvidence(execution.id, patch);
    return retrieved && written !== undefined;
  }

  /**
   * Ask the provider to start an execution that has no provider identity yet.
   *
   * Reached two ways: a fresh `queued` execution the request path did not get to,
   * and a `starting` execution whose process died between recording the intent
   * and recording the handle. Both are answered by submitting again, because the
   * request carries the execution's idempotency key and Compute resolves that key
   * to the job it already has.
   *
   * The failure modes are separated the same way observations are:
   *
   *   - A definitive refusal — `policy_rejected`, `capability_mismatch` — is the
   *     provider answering. Retrying will not change it, so the execution fails
   *     with the provider's own code.
   *   - An unreachable provider leaves the execution non-terminal with the
   *     failure recorded, so a later cycle can finish the submission. Failing it
   *     would throw away work that Compute never refused.
   */
  private async submit(execution: Execution): Promise<Execution> {
    const provider = this.provider!;
    const prepared =
      execution.status === 'queued'
        ? ((await this.store.transition(execution.id, 'starting')) ?? execution)
        : execution;
    try {
      const handle = await provider.start({
        executionId: prepared.id,
        idempotencyKey: prepared.idempotencyKey,
        ...(prepared.taskId ? { taskId: prepared.taskId } : {}),
        ...(prepared.dotId ? { dotId: prepared.dotId } : {}),
        input: { prompt: prepared.prompt },
      });
      const observation = {
        providerExecutionId: handle.providerExecutionId,
        providerSessionId: handle.providerSessionId ?? null,
        lastReconciledAt: Date.now(),
        reconciliationErrorCode: null,
        reconciliationError: null,
      };
      if (prepared.status === 'starting')
        return (
          (await this.store.transition(prepared.id, 'running', observation)) ??
          prepared
        );
      // `starting` with no handle is the interrupted-submission case; recording
      // the handle is an observation, not a second lifecycle move.
      return (await this.store.annotate(prepared.id, observation)) ?? prepared;
    } catch (error) {
      const definitive =
        error instanceof ExecutionProviderError &&
        error.code !== 'transport_failure';
      if (definitive)
        return (
          (await this.store.transition(prepared.id, 'failed', {
            errorCode: errorCode(error),
            error: errorMessage(error),
            lastReconciledAt: Date.now(),
          })) ?? prepared
        );
      return (
        (await this.store.annotate(prepared.id, {
          reconciliationErrorCode: errorCode(error),
          reconciliationError: errorMessage(error),
        })) ?? prepared
      );
    }
  }

  /**
   * Begin reconciling on a timer.
   *
   * Runs one cycle immediately and then every `intervalMs`. Idempotent: calling
   * it twice does not create a second loop, so a mis-ordered startup cannot end
   * up with two reconcilers racing each other on purpose.
   */
  start(): void {
    if (this.timer || !this.provider) return;
    void this.reconcileAll();
    this.timer = setInterval(
      () => void this.reconcileAll(),
      this.options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    );
    // A reconciliation timer must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  /**
   * Stop reconciling and wait for any cycle in flight to finish.
   *
   * Awaiting matters: shutdown closes the durable state, and a cycle still
   * writing when that happens would fail a commit for no reason. Returning before
   * the cycle settles is how orphan loops and spurious shutdown errors happen.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight?.catch(() => undefined);
  }
}

/**
 * The reconciliation interval, from the environment.
 *
 * Read once at startup through the same `process.env` convention the rest of the
 * server uses — no new configuration system, and nothing added to durable state.
 * A nonsensical value falls back to the default rather than failing startup, so a
 * typo in a deployment cannot take the control plane down.
 */
export function reconcileIntervalFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.OPENDOTS_RECONCILE_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1000
    ? raw
    : DEFAULT_RECONCILE_INTERVAL_MS;
}
