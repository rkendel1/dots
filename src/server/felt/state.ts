/**
 * OpenDots' single FeltDB instance.
 *
 * This module is the only place in the application that constructs a
 * `StateFirstDB`. Everything else receives an already-open instance, so the
 * process has exactly one durable state owner and exactly one lock holder.
 */
import { createFeltDB } from '@feltdb/core';
import type { StateFirstDB } from '@feltdb/core';
import {
  assertCollectionsDeclared,
  loadContract,
  RUNTIME_COLLECTIONS,
} from '../contract.js';
import {
  acquireStateLock,
  releaseStateLock,
  stateLockPath,
  type LockRecord,
} from './lock.js';

/**
 * The durable state authority declared by `feltdb.flow`.
 *
 * The collection namespace *is* the contract's application identity, so it is
 * derived from the contract rather than repeated here as a literal — there is
 * one source of truth for who OpenDots is. `FELTDB_NAMESPACE` still overrides
 * it, because two deployments on one machine need to keep their collections
 * apart, and that is deployment configuration rather than architecture.
 */
export const DEFAULT_NAMESPACE = loadContract().app.toLowerCase();
export const DEFAULT_STATE_PATH = 'data/opendots-state';

/**
 * The application's handle on durable state.
 *
 * `close()` is the lifecycle boundary: it closes the runtime and releases the
 * process lock. It is safe to call more than once.
 */
export interface FeltState {
  readonly db: StateFirstDB;
  /** The directory the runtime persists to, or `':memory:'`. */
  readonly path: string;
  /** Ownership record for the process lock; absent for an in-memory state. */
  readonly lock: LockRecord | null;
  /** Path of the lock file, whether or not it currently exists. */
  readonly lockPath: string;
  close(): void;
}

export interface OpenFeltStateOptions {
  /** State directory. Defaults to `FELTDB_PATH`, then `data/opendots-state`. */
  path?: string;
  /** Collection namespace. Defaults to `FELTDB_NAMESPACE`, then `opendots`. */
  namespace?: string;
  /**
   * Use a non-durable in-memory runtime. Used by tests that do not exercise
   * restart behaviour; no lock is taken because nothing is shared.
   */
  memory?: boolean;
}

/** The value `FELTDB_PATH` takes for a non-durable in-memory state. */
export const MEMORY_STATE = ':memory:';

function resolvePath(options: OpenFeltStateOptions) {
  const path = options.path ?? process.env.FELTDB_PATH ?? DEFAULT_STATE_PATH;
  if (options.memory || path === MEMORY_STATE) return MEMORY_STATE;
  return path;
}

/**
 * Open the process-wide state, taking exclusive ownership of its directory.
 *
 * Throws `StateLockedError` when another live process already holds it, which
 * is what keeps a single writer authoritative given FeltDB 0.11.9 does not
 * enforce that itself.
 */
export function openFeltState(options: OpenFeltStateOptions = {}): FeltState {
  const namespace =
    options.namespace ?? process.env.FELTDB_NAMESPACE ?? DEFAULT_NAMESPACE;
  const path = resolvePath(options);
  const lockPath = stateLockPath(path);

  if (path === MEMORY_STATE) {
    const db = createFeltDB({ namespace, memory: true });
    let closed = false;
    return {
      db,
      path,
      lock: null,
      lockPath,
      close() {
        if (closed) return;
        closed = true;
        db.close();
      },
    };
  }

  // The lock is taken before the runtime opens, so two processes cannot both
  // believe they own the directory.
  const lock = acquireStateLock(path);
  let db: StateFirstDB;
  try {
    // Startup consumes the contract before the state opens: a collection the
    // contract does not declare is refused here, at the boundary, rather than
    // surfacing later as an undeclared collection that only this code knows
    // about. There is no SQLite-shaped fallback to fall through to.
    assertCollectionsDeclared(RUNTIME_COLLECTIONS);
    db = createFeltDB({ namespace, mode: 'local', path });
  } catch (error) {
    // Never strand the lock if the runtime fails to open.
    releaseStateLock(path, lock);
    throw error;
  }
  let closed = false;
  return {
    db,
    path,
    lock,
    lockPath,
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } finally {
        releaseStateLock(path, lock);
      }
    },
  };
}

export { StateLockedError, isProcessAlive, stateLockPath } from './lock.js';
export type { LockRecord } from './lock.js';
