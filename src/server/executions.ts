/**
 * `ExecutionStore` — the durable OpenDots execution record.
 *
 * Every execution OpenDots knows about lives here, in FeltDB, and only here.
 * Nothing in this class holds execution state in memory, and nothing outside it
 * writes to the `executions` collection: the lifecycle is expressed as explicit
 * transitions committed under FeltDB's optimistic-concurrency fence, exactly as
 * `Store` does for tasks, so a lost race is detected rather than overwritten.
 *
 * ## Lifecycle
 *
 * ```
 *   queued ──▶ starting ──▶ running ──▶ completed
 *      │           │            │
 *      │           ▼            ▼
 *      └──────▶ cancelled     failed
 * ```
 *
 * `failed` is reachable from `starting` and `running`; `cancelled` from `queued`
 * and `running`. Terminal states are final — a completed execution cannot be
 * reopened, and a late provider reply cannot resurrect one. Transitions are
 * checked here rather than at the API, so no caller can bypass them.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import type { Execution, ExecutionStatus } from '../shared/types.js';
import {
  executionCollections,
  isLostRace,
  toExecution,
  transactionId,
  withoutStorageFields,
  type ExecutionCollections,
  type ExecutionRecord,
} from './execution-collections.js';

export { transactionId, isLostRace };

/**
 * How many times a mutation re-reads and retries after losing a conditional
 * write. Matches `Store`, and for the same reason: a retry needs a fresh
 * transaction id so FeltDB cannot deduplicate it into a silent no-op.
 */
const MAX_ATTEMPTS = 8;

/**
 * The transitions this domain permits.
 *
 * Exported because the rules are the invariant, not an implementation detail:
 * the API must not offer an action this table forbids, and the tests must be
 * able to state the whole vocabulary rather than restate it.
 */
export const EXECUTION_TRANSITIONS: Readonly<
  Record<ExecutionStatus, readonly ExecutionStatus[]>
> = {
  queued: ['starting', 'cancelled', 'failed'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
} as const;

export function isTerminal(status: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[status].length === 0;
}

/**
 * How long after settling OpenDots keeps asking for a missing receipt.
 *
 * Compute seals a receipt when it finishes sealing an execution, which is not
 * the same instant the job status becomes terminal. So a short gap is normal and
 * worth retrying. But retrying forever would mean one HTTP request per cycle per
 * historical execution, for an execution that will never produce one — a plain
 * session execution, say, or anything the provider does not evidence.
 *
 * The window is a scheduling bound, not durable state: it is derived from the
 * already-durable `completedAt`, so a restart resumes the same decision rather
 * than resetting it.
 */
export const RECEIPT_GRACE_MS = 15 * 60_000;

function withinReceiptGrace(
  record: { completedAt?: number | null },
  now: number,
): boolean {
  if (!record.completedAt) return false;
  return now - record.completedAt <= RECEIPT_GRACE_MS;
}

/**
 * What a reconciliation pass can write.
 *
 * Shared by `transition` and `annotate` so that a lifecycle move and an
 * observation-only refresh cannot drift apart in what they are able to record.
 * Every field is optional and absent means "leave as it was" — which is what
 * makes the two operations safe to retry.
 */
export interface ExecutionObservation {
  providerExecutionId?: string | null;
  providerSessionId?: string | null;
  providerStatus?: string | null;
  result?: unknown;
  errorCode?: string | null;
  error?: string | null;
  /** When the provider was last successfully observed. */
  lastReconciledAt?: number | null;
  /** Whether the result payload was actually retrieved from the provider. */
  resultRetrieved?: boolean;
  /** The provider's receipt, stored verbatim. */
  receipt?: unknown;
  /** The provider's error kind from a failed reconciliation attempt. */
  reconciliationErrorCode?: string | null;
  /** Why the last reconciliation attempt failed. */
  reconciliationError?: string | null;
}

/**
 * Overlay an observation onto a stored record.
 *
 * `undefined` means "not observed this time" and leaves the field alone, which
 * is what lets a repeated pass be idempotent rather than blanking fields it did
 * not re-read.
 */
export function applyObservation(
  record: ExecutionRecord,
  patch: ExecutionObservation,
): Execution {
  const pick = <K extends keyof ExecutionObservation>(
    key: K,
    fallback: Execution[K & keyof Execution],
  ): Execution[K & keyof Execution] => {
    const value = patch[key];
    return value === undefined
      ? fallback
      : (value as Execution[K & keyof Execution]);
  };
  return {
    ...withoutStorageFields(record),
    id: record.id,
    providerExecutionId: pick(
      'providerExecutionId',
      record.providerExecutionId,
    ),
    providerSessionId: pick('providerSessionId', record.providerSessionId),
    providerStatus: pick('providerStatus', record.providerStatus),
    result: pick('result', record.result),
    errorCode: pick('errorCode', record.errorCode),
    error: pick('error', record.error),
    lastReconciledAt: pick('lastReconciledAt', record.lastReconciledAt),
    resultRetrieved: pick('resultRetrieved', record.resultRetrieved ?? false),
    receipt: pick('receipt', record.receipt ?? null),
    reconciliationErrorCode: pick(
      'reconciliationErrorCode',
      record.reconciliationErrorCode,
    ),
    reconciliationError: pick(
      'reconciliationError',
      record.reconciliationError,
    ),
  };
}

export class InvalidExecutionTransition extends Error {
  constructor(
    readonly from: ExecutionStatus,
    readonly to: ExecutionStatus,
  ) {
    super(
      `An execution cannot go from "${from}" to "${to}". ` +
        `Permitted: ${
          EXECUTION_TRANSITIONS[from].length
            ? EXECUTION_TRANSITIONS[from].join(', ')
            : 'none — it has already finished'
        }.`,
    );
    this.name = 'InvalidExecutionTransition';
  }
}

export interface CreateExecutionInput {
  taskId?: string | null;
  dotId?: string | null;
  provider: string;
  prompt: string;
  /**
   * The key that makes submission repeatable.
   *
   * Supplied by the caller so a retry of the same user action reuses it. When
   * omitted a fresh one is generated, which is correct for a genuinely new
   * request and wrong for a retry — callers retrying must pass their own.
   */
  idempotencyKey?: string;
}

/**
 * The execution's durable identity, derived from its idempotency key.
 *
 * This is what makes {@link ExecutionStore.create} atomic. A `requireAbsent`
 * guard only protects the *record key*, so guarding a random UUID would let two
 * concurrent requests both insert — the unique index on `idempotencyKey` would
 * then reject one, but as an error rather than as convergence, and the losing
 * caller would see a failure where the correct answer is the winner's execution.
 *
 * Deriving the key from the request identity makes the guard and the intent the
 * same thing: two requests carrying the same key address the same record, so the
 * database itself decides the winner. Nothing has to trust a read-then-write.
 *
 * Hashed rather than used verbatim so the durable key carries no caller-supplied
 * text, and prefixed so a stored execution is recognizable in a data dump.
 */
export function executionIdFor(idempotencyKey: string): string {
  return `exec_${createHash('sha256').update(idempotencyKey).digest('hex')}`;
}

export class ExecutionStore {
  private readonly state: StateFirstDB;
  private readonly felt: ExecutionCollections;

  constructor(state: StateFirstDB) {
    this.state = state;
    this.felt = executionCollections(state);
  }

  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }

  /** Newest first, matching `Store.tasks()`. */
  async list(filter: { taskId?: string } = {}): Promise<Execution[]> {
    const rows = await this.felt.executions.all();
    return rows
      .filter((row) => !filter.taskId || row.taskId === filter.taskId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(toExecution);
  }

  async get(id: string): Promise<Execution | undefined> {
    const record = await this.felt.executions.get(id);
    return record ? toExecution(record) : undefined;
  }

  /** Every execution that has not reached a terminal state. */
  async active(): Promise<Execution[]> {
    const rows = await this.felt.executions.all();
    return rows
      .filter((row) => !isTerminal(row.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toExecution);
  }

  /**
   * Find the execution a previous request for this key already created.
   *
   * This is OpenDots' half of idempotency. The unique index on `idempotencyKey`
   * makes the durable half authoritative — this lookup is the fast path, and the
   * index is what actually prevents a duplicate when two requests race.
   */
  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<Execution | undefined> {
    const rows = await this.felt.executions.all();
    const match = rows.find((row) => row.idempotencyKey === idempotencyKey);
    return match ? toExecution(match) : undefined;
  }

  /**
   * Create a queued execution, or return the one this key already created.
   *
   * Atomic because the record key *is* the request identity — see
   * {@link executionIdFor}. Two concurrent requests carrying the same key address
   * the same record, so the `requireAbsent` guard lets exactly one of them win and
   * the loser reads back the winner's execution. The unique index in
   * `feltdb.flow` is a second line of defence rather than the mechanism, so a
   * future change to the key derivation cannot silently weaken this.
   */
  async create(
    input: CreateExecutionInput,
  ): Promise<{ execution: Execution; created: boolean }> {
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const id = executionIdFor(idempotencyKey);
    const execution: Execution = {
      id,
      taskId: input.taskId ?? null,
      dotId: input.dotId ?? null,
      status: 'queued',
      provider: input.provider,
      providerExecutionId: null,
      providerSessionId: null,
      providerStatus: null,
      idempotencyKey,
      prompt: input.prompt,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      result: null,
      errorCode: null,
      error: null,
      lastReconciledAt: null,
      resultRetrieved: false,
      receipt: null,
      reconciliationErrorCode: null,
      reconciliationError: null,
    };
    try {
      await this.commit('execution-create', (tx) =>
        tx
          .collection<ExecutionRecord>('executions')
          .set(id, { ...execution, __version: 1 }, { requireAbsent: true }),
      );
      return { execution, created: true };
    } catch (error) {
      // Another request for this same key already wrote the record. Because the
      // durable key is derived from the key, that record *is* this execution, so
      // returning it is the correct answer rather than a failure.
      if (isLostRace(error)) {
        const winner = await this.get(id);
        if (winner) return { execution: winner, created: false };
      }
      throw error;
    }
  }

  /**
   * Every execution whose provider evidence is not fully collected yet.
   *
   * Discovered from durable state, not from memory, which is what lets a result
   * that failed to download be picked up by a later cycle — or by a later
   * process — without anyone remembering that it was outstanding.
   */
  async pendingRetrievals(now = Date.now()): Promise<Execution[]> {
    const rows = await this.felt.executions.all();
    return rows
      .filter((row) => isTerminal(row.status))
      .filter((row) => !row.resultRetrieved || !row.receipt)
      .filter((row) => withinReceiptGrace(row, now))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toExecution);
  }

  /**
   * Move an execution to a new lifecycle state.
   *
   * The transition is validated before anything is written, the write is fenced
   * on the version that was read, and the whole thing retries on a lost race —
   * so two processes reconciling the same execution cannot interleave into an
   * impossible state, and a terminal execution is never reopened.
   *
   * Returns the updated execution, or `undefined` when the execution is unknown
   * or already terminal: a late provider reply for finished work is discarded
   * rather than applied.
   */
  async transition(
    id: string,
    to: ExecutionStatus,
    patch: ExecutionObservation & { now?: number } = {},
  ): Promise<Execution | undefined> {
    const now = patch.now ?? Date.now();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.felt.executions.get(id);
      if (!record) return undefined;
      if (isTerminal(record.status)) return undefined;
      if (!EXECUTION_TRANSITIONS[record.status].includes(to))
        throw new InvalidExecutionTransition(record.status, to);
      const version = record.__version ?? 1;
      const next: Execution = {
        ...toExecution(record),
        ...applyObservation(record, patch),
        status: to,
        startedAt:
          record.startedAt ??
          (to === 'starting' || to === 'running' ? now : null),
        completedAt: isTerminal(to) ? now : record.completedAt,
      };
      try {
        await this.commit('execution-transition', (tx) =>
          tx
            .collection<ExecutionRecord>('executions')
            .set(
              id,
              { ...next, __version: version + 1 },
              { expectedVersion: version },
            ),
        );
        return next;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
    return undefined;
  }

  /**
   * Record what the provider just said, without moving the lifecycle.
   *
   * Polling is inherently repetitive: asking about an execution that is still
   * running must be a no-op rather than an error, and it must still record the
   * provider's exact word. Forcing that through {@link transition} would mean
   * either allowing self-transitions — weakening the table into something that no
   * longer reads as a lifecycle — or skipping the write and losing the
   * observation.
   *
   * The lifecycle is untouched, so this cannot complete, fail or cancel anything.
   *
   * A terminal execution is refused. That is what stops a stale reconciliation —
   * one that read the record before another pass finished it — from writing an
   * outdated observation over a settled outcome. Use {@link recordEvidence} for
   * evidence that legitimately arrives after an execution settled.
   */
  async annotate(
    id: string,
    patch: ExecutionObservation,
  ): Promise<Execution | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.felt.executions.get(id);
      if (!record) return undefined;
      if (isTerminal(record.status)) return undefined;
      const version = record.__version ?? 1;
      const next = applyObservation(record, patch);
      try {
        await this.commit('execution-annotate', (tx) =>
          tx
            .collection<ExecutionRecord>('executions')
            .set(
              id,
              { ...next, __version: version + 1 },
              { expectedVersion: version },
            ),
        );
        return next;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
    return undefined;
  }

  /**
   * Record provider evidence against an execution whose lifecycle is settled.
   *
   * The one write path that may touch a terminal execution, and it deliberately
   * cannot move the lifecycle: `status`, `startedAt` and `completedAt` are not in
   * the patch type, so there is no version of this call that reopens or re-decides
   * a finished execution.
   *
   * This exists because `annotate` refuses terminal records — the right default
   * for a stale pass racing a completion — but a result or receipt legitimately
   * arrives *after* the execution settled, and has to land somewhere.
   */
  async recordEvidence(
    id: string,
    patch: ExecutionObservation,
  ): Promise<Execution | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.felt.executions.get(id);
      if (!record) return undefined;
      const version = record.__version ?? 1;
      // Only evidence may change: the lifecycle fields are carried through from
      // the stored record untouched.
      const next = applyObservation(record, patch);
      try {
        await this.commit('execution-evidence', (tx) =>
          tx
            .collection<ExecutionRecord>('executions')
            .set(
              id,
              { ...next, __version: version + 1 },
              { expectedVersion: version },
            ),
        );
        return next;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
    return undefined;
  }
}
