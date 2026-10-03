import { randomUUID } from 'node:crypto';
import type { StateFirstDB } from '@feltdb/core';

/**
 * FeltDB plumbing shared by every collection module.
 *
 * These are storage primitives, not a persistence abstraction: they know about
 * transaction identity, lost-race detection, and stripping FeltDB's own
 * metadata. They know nothing about any OpenDots domain.
 */

/** The only per-record field FeltDB owns. Never a domain field. */
export interface StorageFence {
  __version?: number;
}

/**
 * A transaction id that is unique per attempt.
 *
 * Reusing one is not free: the second concurrent call reports `duplicate: true`
 * and applies none of its operations, which would silently drop a mutation the
 * caller was promised. Every non-idempotent mutation therefore gets a fresh id.
 */
export function transactionId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Whether a refusal was a lost conditional race rather than a real failure.
 *
 * `conditionalRefusal()` from `@feltdb/core` is deliberately not used: it only
 * recognises `feltdbCode` and HTTP 409, so it reports `{conflict: false}` for the
 * `ConditionalConflictError` an embedded runtime actually throws. The typed
 * error's `code` is the reliable signal.
 */
export function isLostRace(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'PRECONDITION_FAILED'
  );
}

/**
 * Descending sort that keeps insertion (rowid) order for ties.
 *
 * `Array.prototype.sort` is stable, so sorting an `all()` result reproduces
 * SQLite's `ORDER BY <timestamp> DESC` exactly, including its undefined ordering
 * among rows that share a timestamp.
 */
export function byTimestampDesc<T extends { createdAt: number }>(rows: T[]) {
  return [...rows].sort((a, b) => b.createdAt - a.createdAt);
}

/** The same, but for SQLite's `ORDER BY startedAt DESC, rowid DESC`. */
export function byStartedAtDescRowidDesc<T extends { startedAt: number }>(
  rows: T[],
) {
  return [...rows].reverse().sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Strip FeltDB's own metadata from a record before it crosses the application
 * boundary.
 *
 * Two fields, not one: `__version` is the storage fence, and `id` is written by
 * `put`/`insert`/`putIfAbsent` from the record key, which would otherwise leak
 * into any domain object that does not already have an `id`.
 */
export function withoutStorageFields<T extends StorageFence>(
  record: T & { id?: string },
): Omit<T, '__version'> & { id?: string } {
  const { __version: _fence, ...rest } = record;
  void _fence;
  return rest;
}

/**
 * Strip storage metadata and reinstate a domain id the record does not own.
 *
 * Used where the domain id is derived (an event sequence) rather than stored, so
 * the injected key would otherwise be mistaken for the domain id.
 */
export function withDomainId<T extends StorageFence, D extends object>(
  record: T & { id?: string },
  build: (rest: Omit<T, '__version'>) => D,
): D {
  const { __version: _fence, ...rest } = record;
  void _fence;
  return build(rest);
}

export type { StateFirstDB };
