/**
 * `DecisionStore` — durable immutable human decisions about attention items.
 *
 * Decisions are created once and never modified. If a human changes their mind,
 * a new decision record is created; the old one is not rewritten. This preserves
 * the complete decision history for audit and replay purposes.
 *
 * Decision identity is deterministic based on the attention item, the decision
 * type, and the actor, so identical submissions are safe to retry without
 * creating duplicates.
 */
import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import type { Decision, DecisionValue } from '../shared/types.js';
import {
  decisionCollections,
  decisionIdFor,
  toDecision,
  type DecisionCollections,
  type DecisionRecord,
} from './decision-collections.js';
import { isLostRace, transactionId } from './felt/records.js';

export interface CreateDecisionInput {
  attentionId: string;
  decision: DecisionValue;
  actorType: 'human';
  actorId: string;
}

export class DecisionStore {
  private readonly state: StateFirstDB;
  private readonly felt: DecisionCollections;

  constructor(state: StateFirstDB) {
    this.state = state;
    this.felt = decisionCollections(state);
  }

  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }

  /** All decisions for a given attention item, oldest first. */
  async listForAttention(attentionId: string): Promise<Decision[]> {
    const rows = (await this.felt.decisions.all()).filter(
      (row) => row.attentionId === attentionId,
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt).map(toDecision);
  }

  /**
   * Record a decision, creating it if it does not exist.
   *
   * Idempotent by key: identical submissions address the same record. If a
   * decision with this identity (attention + decision + actor) already exists,
   * it is returned unchanged. If the human makes a different decision on the
   * same attention, that is a new record.
   *
   * Returns whether this call created the decision, so a caller can tell "I
   * created this" from "this was already here" without re-reading.
   */
  async create(input: CreateDecisionInput): Promise<{
    decision: Decision;
    created: boolean;
  }> {
    const id = decisionIdFor(
      input.attentionId,
      input.decision,
      input.actorType,
      input.actorId,
    );
    const now = Date.now();
    const record: DecisionRecord = {
      id,
      attentionId: input.attentionId,
      decision: input.decision,
      actorType: input.actorType,
      actorId: input.actorId,
      createdAt: now,
    };
    try {
      await this.commit('decision-create', (tx) =>
        tx
          .collection<DecisionRecord>('decisions')
          .set(id, record, { requireAbsent: true }),
      );
      return { decision: toDecision(record), created: true };
    } catch (error) {
      // Already created by an earlier pass, or by a concurrent one. Either way
      // the existing decision is the truth and must not be rewritten.
      if (isLostRace(error) || isDuplicate(error)) {
        const existing = await this.get(id);
        if (existing) return { decision: existing, created: false };
      }
      throw error;
    }
  }

  /** Retrieve a single decision by its id. */
  async get(id: string): Promise<Decision | undefined> {
    const record = await this.felt.decisions.get(id);
    return record ? toDecision(record) : undefined;
  }
}

/**
 * Whether an error means "this row is already there".
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
