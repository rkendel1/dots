/**
 * `AttentionStore` — durable attention items.
 *
 * Every write here is idempotent by construction, because the record key *is*
 * the condition's identity (see {@link attentionIdFor}). Two evaluations of the
 * same condition do not race in any meaningful sense: they address one row, and
 * the store decides which observation lands.
 *
 * ## Why only disposition is mutable
 *
 * `kind`, `severity`, `title` and `summary` describe what the condition *is*,
 * and those do not change while it holds. What changes is human disposition —
 * acknowledged, resolved — plus the system's own observation that the condition
 * stopped holding. Those are the only fields {@link AttentionStore.acknowledge},
 * {@link AttentionStore.resolve} and {@link AttentionStore.clearCondition} touch,
 * so a human decision can never be silently overwritten by a later evaluation.
 */
import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import type {
  Attention,
  AttentionKind,
  AttentionSourceType,
  AttentionStatus,
} from '../shared/types.js';
import {
  attentionCollections,
  attentionIdFor,
  toAttention,
  type AttentionCollections,
  type AttentionRecord,
} from './attention-collections.js';
import {
  isLostRace,
  transactionId,
  withoutStorageFields,
} from './felt/records.js';

/**
 * What the evaluator believes about one condition.
 *
 * A description, never a mutation: the store decides whether this creates an
 * item or leaves an existing one alone.
 */
export interface AttentionCondition {
  kind: AttentionKind;
  severity: Attention['severity'];
  title: string;
  summary: string;
  sourceType: AttentionSourceType;
  sourceId: string;
}

export interface AttentionListFilter {
  status?: AttentionStatus;
  kind?: AttentionKind;
  /** Only items whose condition has not been observed as cleared. */
  active?: boolean;
}

const MAX_ATTEMPTS = 5;

export class AttentionStore {
  private readonly state: StateFirstDB;
  private readonly felt: AttentionCollections;

  constructor(state: StateFirstDB) {
    this.state = state;
    this.felt = attentionCollections(state);
  }

  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }

  async get(id: string): Promise<Attention | undefined> {
    const record = await this.felt.attention.get(id);
    return record ? toAttention(record) : undefined;
  }

  /** Every item, newest first. Deliberately unfiltered — callers decide. */
  async list(filter: AttentionListFilter = {}): Promise<Attention[]> {
    const rows = (await this.felt.attention.all()).filter((row) =>
      matches(row, filter),
    );
    return rows
      .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)
      .map(toAttention);
  }

  /**
   * Record a condition, creating the item if it does not exist.
   *
   * Idempotent by key, and the write is create-only: an item that already exists
   * is left exactly as it is. That is what stops a reconciliation cycle running
   * every few seconds from rewriting `createdAt`, resetting a human's
   * acknowledgement, or re-raising something they resolved.
   *
   * Returns whether this call created the item, so a caller can tell "I raised
   * this" from "this was already here" without re-reading.
   */
  async raise(condition: AttentionCondition): Promise<{
    attention: Attention;
    created: boolean;
  }> {
    const id = attentionIdFor(
      condition.kind,
      condition.sourceType,
      condition.sourceId,
    );
    const now = Date.now();
    const record: AttentionRecord = {
      id,
      kind: condition.kind,
      severity: condition.severity,
      status: 'open',
      title: condition.title,
      summary: condition.summary,
      sourceType: condition.sourceType,
      sourceId: condition.sourceId,
      createdAt: now,
      updatedAt: now,
      acknowledgedAt: null,
      resolvedAt: null,
      conditionClearedAt: null,
    };
    try {
      await this.commit('attention-raise', (tx) =>
        tx
          .collection<AttentionRecord>('attention')
          .set(id, record, { requireAbsent: true }),
      );
      return { attention: toAttention(record), created: true };
    } catch (error) {
      // Already raised by an earlier pass, or by a concurrent one. Either way the
      // existing item is the truth and must not be rewritten.
      if (isLostRace(error) || isDuplicate(error)) {
        const existing = await this.get(id);
        if (existing) return { attention: existing, created: false };
      }
      throw error;
    }
  }

  /**
   * Note that a condition no longer holds.
   *
   * A system observation and deliberately **not** a resolution. A provider that
   * comes back has stopped causing a problem; it has not decided anything on a
   * human's behalf. The item leaves the "needs attention" view because of
   * `conditionClearedAt`, and stays `open` until someone resolves it.
   */
  async clearCondition(id: string): Promise<Attention | undefined> {
    return this.patch(id, { conditionClearedAt: Date.now() });
  }

  /**
   * Mark an item seen.
   *
   * Acknowledging is not resolving and is not undone by this: the item keeps
   * demanding attention until the condition itself clears or someone resolves it.
   */
  async acknowledge(id: string): Promise<Attention | undefined> {
    const now = Date.now();
    return this.patch(id, { status: 'acknowledged', acknowledgedAt: now });
  }

  /** Mark an item dealt with. The only path that sets `resolvedAt`. */
  async resolve(id: string): Promise<Attention | undefined> {
    const now = Date.now();
    return this.patch(id, { status: 'resolved', resolvedAt: now });
  }

  /**
   * Apply a human disposition.
   *
   * Fenced on the version that was read and retried on a lost race, so two
   * acknowledgements landing together produce one state change rather than two
   * competing ones. A resolved item is refused any patch that would move it back
   * to `open` or `acknowledged`: once someone has closed something, nothing
   * silently reopens it.
   */
  private async patch(
    id: string,
    patch: Partial<
      Pick<
        Attention,
        'status' | 'acknowledgedAt' | 'resolvedAt' | 'conditionClearedAt'
      >
    >,
  ): Promise<Attention | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.felt.attention.get(id);
      if (!record) return undefined;
      if (record.status === 'resolved' && patch.status !== 'resolved')
        return toAttention(record);
      const version = record.__version ?? 1;
      const next: AttentionRecord = {
        ...withoutStorageFields(record),
        ...patch,
        updatedAt: Date.now(),
        __version: version + 1,
      };
      try {
        await this.commit('attention-patch', (tx) =>
          tx
            .collection<AttentionRecord>('attention')
            .set(id, next, { expectedVersion: version }),
        );
        return toAttention(next);
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
    return undefined;
  }
}

/**
 * Whether an item still needs a human.
 *
 * An item whose condition has cleared is not in this set even while it is still
 * `open`, because nothing is wrong any more. An item nobody has acted on *is*,
 * which is what makes "needs attention" survive a restart unchanged.
 */
export function needsAttention(item: Attention): boolean {
  return item.conditionClearedAt === null && item.status !== 'resolved';
}

function matches(record: AttentionRecord, filter: AttentionListFilter) {
  if (filter.status && record.status !== filter.status) return false;
  if (filter.kind && record.kind !== filter.kind) return false;
  if (filter.active === true && !needsAttention(toAttention(record)))
    return false;
  return true;
}

/**
 * Whether an error means "this row is already there".
 *
 * FeltDB reports a create-only conflict as a duplicate operation or a unique
 * violation depending on which path was taken, and neither is the
 * `PRECONDITION_FAILED` that {@link isLostRace} recognises. Without this, the
 * second evaluation of one condition would throw instead of converging — the
 * exact failure the deterministic key exists to make impossible.
 */
function isDuplicate(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    code?: string;
    feltdbCode?: string;
    message?: string;
  };
  const code = candidate.code ?? candidate.feltdbCode ?? '';
  return (
    code === 'DUPLICATE' ||
    code === 'ALREADY_EXISTS' ||
    code === 'UNIQUE_CONSTRAINT' ||
    /duplicate|already exists/i.test(candidate.message ?? '')
  );
}
