/**
 * FeltDB storage for `AttentionStore`.
 *
 * Field names match `feltdb.flow` exactly, so `toAttention` is a pure
 * storage-metadata strip with no mapping layer — the same relationship
 * `execution-collections.ts` has with the rest of the schema.
 */
import { createHash } from 'node:crypto';
import type { Collection, StateFirstDB } from '@feltdb/core';
import type {
  Attention,
  AttentionKind,
  AttentionSourceType,
} from '../shared/types.js';
import type { StorageFence } from './felt/records.js';

export interface AttentionRecord extends Attention, StorageFence {}

export interface AttentionCollections {
  attention: Collection<AttentionRecord>;
}

export function attentionCollections(db: StateFirstDB): AttentionCollections {
  return {
    attention: db.collection<AttentionRecord>('attention'),
  };
}

/**
 * The durable identity of an attention *condition*.
 *
 * This is the whole of the deduplication mechanism, and it is why no random UUID
 * appears anywhere in this module. The id is a pure function of *what the
 * condition is about* — its kind plus the entity carrying it — so evaluating the
 * same condition a thousand times addresses the same record. Convergence is
 * therefore a property of the key rather than a property of any check-then-write
 * that could race.
 *
 * The parts are length-prefixed before hashing, so `('a', 'bc')` and `('ab', 'c')`
 * cannot collide. That matters because `sourceId` values are attacker-adjacent in
 * the sense that a prompt can become one: an execution id and a kind must not be
 * able to be re-split into a different pair producing the same digest.
 *
 * `sourceType` participates because the same id string can legitimately name
 * different kinds of entity, and a provider-level outage must not merge with a
 * per-execution condition that happens to reference the same text.
 */
export function attentionIdFor(
  kind: AttentionKind,
  sourceType: AttentionSourceType,
  sourceId: string,
): string {
  const digest = createHash('sha256')
    .update(
      [kind, sourceType, sourceId]
        .map((part) => `${part.length}:${part}`)
        .join(''),
    )
    .digest('hex');
  return `attn_${digest}`;
}

/** Strip FeltDB's own metadata before an item crosses the application boundary. */
export function toAttention(record: AttentionRecord): Attention {
  const { __version: _version, ...rest } = record;
  void _version;
  return rest;
}
