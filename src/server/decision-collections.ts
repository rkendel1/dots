/**
 * FeltDB storage for decisions.
 *
 * Decisions are immutable human facts: "this actor made this decision about this
 * condition at this time." The id is deterministic so identical submissions are
 * idempotent (same decision record), but a different decision on the same
 * attention item is a new row — history is preserved forever.
 */
import { createHash } from 'node:crypto';
import type { Collection, StateFirstDB } from '@feltdb/core';
import type { Decision, DecisionValue } from '../shared/types.js';
import type { StorageFence } from './felt/records.js';

export interface DecisionRecord extends Decision, StorageFence {}

export interface DecisionCollections {
  decisions: Collection<DecisionRecord>;
}

export function decisionCollections(db: StateFirstDB): DecisionCollections {
  return {
    decisions: db.collection<DecisionRecord>('decisions'),
  };
}

/**
 * The durable identity of a decision event.
 *
 * A decision is keyed by the attention it addresses, the decision being made, and
 * the actor making it. This makes identical submissions idempotent (same record)
 * while allowing a different decision by the same actor on the same attention to
 * create a new row.
 *
 * The parts are length-prefixed before hashing to prevent collision between
 * different combinations (e.g., ('a', 'bc') and ('ab', 'c')).
 */
export function decisionIdFor(
  attentionId: string,
  decision: DecisionValue,
  actorType: string,
  actorId: string,
): string {
  const digest = createHash('sha256')
    .update(
      [attentionId, decision, actorType, actorId]
        .map((part) => `${part.length}:${part}`)
        .join(''),
    )
    .digest('hex');
  return `dec_${digest}`;
}

/** Strip FeltDB's own metadata before a decision crosses the application boundary. */
export function toDecision(record: DecisionRecord): Decision {
  const { __version: _version, ...rest } = record;
  void _version;
  return rest;
}
