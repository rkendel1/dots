/**
 * Apply an import plan to the FeltDB state.
 *
 * Idempotency is the point of this module. Every planned write is a create, and
 * every record is classified before anything is written:
 *
 *   target key absent             -> create
 *   target key present, same data -> skip, already migrated
 *   target key present, different -> conflict
 *
 * A conflict aborts the whole migration before the first write, so the target is
 * either fully migrated or untouched — never half-applied and never silently
 * overwritten.
 *
 * Records that must be consistent with each other — a page reservation and its
 * thread marker — are classified and written as one unit, so a partially
 * migrated pair is not observable.
 */
import type { StateFirstDB } from '@feltdb/core';
import { transactionId } from '../src/server/felt/records.js';
import type { MigrationPlan, PlannedWrite } from './import-plan.js';

export interface ApplyOutcome {
  created: number;
  skipped: number;
  conflicts: { collection: string; id: string }[];
}

export interface ApplyOptions {
  /** Records per FeltDB transaction. */
  batchSize?: number;
}

/**
 * Compare an existing stored record with the value we intend to write.
 *
 * `__version` is FeltDB's storage fence and the `id` it injects is derived from
 * the key, so neither is part of the domain content being compared.
 */
/**
 * Normalise a record for comparison.
 *
 * Two FeltDB-owned fields are removed, and which of them depends on the planned
 * value:
 *
 *   - `__version` is always storage bookkeeping, so it never compares.
 *   - `id` is injected from the record key by `set`/`put`/`insert`. It is only
 *     ignored when the *planned* record does not own an `id`; a record whose
 *     domain shape really has an `id` (a Dot, a call, a page) must still compare
 *     it, or a genuinely changed identity would pass as "already migrated".
 *
 * `undefined` values are dropped on both sides because JSON has no `undefined`:
 * a field absent from the plan and present as `undefined` after a round trip
 * describes the same record.
 */
export function sameContent(
  existing: Record<string, unknown>,
  planned: Record<string, unknown>,
): boolean {
  const strip = (value: Record<string, unknown>, ignoreInjectedId: boolean) => {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === '__version' || entry === undefined) continue;
      // Only drop the storage id where the domain shape has no id of its own.
      if (ignoreInjectedId && key === 'id') continue;
      out[key] = entry;
    }
    return out;
  };
  return eq(
    strip(existing, !('id' in planned)),
    strip(planned, !('id' in planned)),
  );
}

/**
 * Structural equality, insensitive to key order.
 *
 * `JSON.stringify` on the two whole objects would compare key order as well as
 * content; records built by the planner and records read back from storage are
 * assembled in different orders, and a false "conflict" would be a much worse
 * outcome than the one it tried to catch.
 */
function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((entry, index) => eq(entry, b[index]));
  }
  if (typeof a !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && eq(left[key], right[key]));
}

/**
 * Group a reservation with its thread marker so both land together.
 *
 * The marker is the migration-era stand-in for SQLite's `UNIQUE(threadId)`; if
 * one existed without the other the invariant would be broken.
 */
export function groupCoupled(writes: PlannedWrite[]): PlannedWrite[][] {
  const groups: PlannedWrite[][] = [];
  const claimed = new Set<PlannedWrite>();
  for (const item of writes) {
    if (claimed.has(item)) continue;
    const group = [item];
    claimed.add(item);
    if (item.collection === 'page_threads' && item.coupledTo) {
      const marker = writes.find(
        (other) =>
          other.collection === 'page_thread_ids' && other.id === item.coupledTo,
      );
      if (marker) {
        group.push(marker);
        claimed.add(marker);
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Decide what would happen to every record, without writing anything.
 *
 * Returning this before committing is what makes "fail loudly on a conflicting
 * target" and "never leave the target in a known-invalid state" both true.
 */
export async function classifyPlan(
  state: StateFirstDB,
  plan: MigrationPlan,
): Promise<{
  groups: { create: PlannedWrite[]; skip: number }[];
  conflicts: { collection: string; id: string }[];
}> {
  const conflicts: { collection: string; id: string }[] = [];
  const groups: { create: PlannedWrite[]; skip: number }[] = [];
  for (const group of groupCoupled(plan.writes)) {
    const create: PlannedWrite[] = [];
    let skip = 0;
    for (const item of group) {
      const existing = await state.collection(item.collection).get(item.id);
      if (!existing) {
        create.push(item);
        continue;
      }
      if (sameContent(existing as Record<string, unknown>, item.value)) {
        skip++;
        continue;
      }
      conflicts.push({ collection: item.collection, id: item.id });
    }
    groups.push({ create, skip });
  }
  return { groups, conflicts };
}

/** Commit a classified plan. Assumes `classifyPlan` found no conflicts. */
export async function applyPlan(
  state: StateFirstDB,
  plan: MigrationPlan,
  options: ApplyOptions = {},
): Promise<ApplyOutcome> {
  const { groups, conflicts } = await classifyPlan(state, plan);
  if (conflicts.length) return { created: 0, skipped: 0, conflicts };
  const outcome: ApplyOutcome = {
    created: 0,
    skipped: 0,
    conflicts: [],
  };
  const batchSize = options.batchSize ?? 50;

  // Batches are built from whole groups, never from a flat list of writes: a
  // batch boundary in the middle of a coupled group would commit half of a
  // reservation. Groups are packed greedily up to the batch size, so a group
  // larger than the limit still lands in one transaction rather than being
  // split — correctness of the invariant outranks the transaction size.
  const batches: PlannedWrite[][] = [];
  for (const group of groups) {
    outcome.skipped += group.skip;
    const creates = group.create;
    if (!creates.length) continue;
    const current = batches[batches.length - 1];
    if (current && current.length + creates.length <= batchSize) {
      current.push(...creates);
      continue;
    }
    batches.push([...creates]);
  }

  for (const batch of batches) {
    await state.transaction(
      (tx) => {
        for (const item of batch)
          tx.collection(item.collection).set(item.id, item.value, {
            requireAbsent: true,
          });
      },
      { transactionId: transactionId('migrate') },
    );
    outcome.created += batch.length;
  }
  return outcome;
}
