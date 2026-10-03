import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

const LOCK_SUFFIX = '.lock';

/** A durable, inspectable record of which process owns the state directory. */
export interface LockRecord {
  pid: number;
  hostname: string;
  acquiredAt: number;
}

export class StateLockedError extends Error {
  override name = 'StateLockedError';
  constructor(
    readonly lockPath: string,
    readonly holder: LockRecord | null,
  ) {
    super(
      holder
        ? `OpenDots state at ${lockPath} is already held by pid ${holder.pid} on ${holder.hostname}. Only one OpenDots process may own its state at a time.`
        : `OpenDots state at ${lockPath} is locked by another process.`,
    );
  }
}

function lockPathFor(statePath: string) {
  return `${statePath}${LOCK_SUFFIX}`;
}

function parseRecord(raw: string): LockRecord | null {
  let value: Partial<LockRecord>;
  try {
    value = JSON.parse(raw) as Partial<LockRecord>;
  } catch {
    // An unparseable lock file is treated as held: refusing to start is the
    // safe failure, and the owner removing the file resolves it.
    return null;
  }
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid))
    return null;
  return {
    pid: value.pid,
    // A record without a host is treated as local, so a dead owner is still
    // reclaimable instead of leaving a lock nothing can ever clear.
    hostname: typeof value.hostname === 'string' ? value.hostname : '',
    acquiredAt: typeof value.acquiredAt === 'number' ? value.acquiredAt : 0,
  };
}

function readHolder(lockPath: string): LockRecord | null {
  try {
    return parseRecord(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * True when `pid` is a live process that is not this one.
 *
 * `process.kill(pid, 0)` performs the permission and existence checks without
 * delivering a signal. EPERM means the process exists but belongs to another
 * user, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take exclusive ownership of a state directory.
 *
 * FeltDB's file runtime does not refuse a second writer (verified in
 * @feltdb/core 0.11.9), so OpenDots enforces that boundary itself. The lock
 * is an `O_EXCL` file created beside the state directory, which makes
 * acquisition atomic across processes on the same host and across containers
 * sharing a volume.
 *
 * A lock left behind by a process that no longer exists is reclaimed, so a
 * crash cannot permanently block startup.
 */
export function acquireStateLock(statePath: string): LockRecord {
  const lockPath = lockPathFor(statePath);
  mkdirSync(dirname(lockPath), { recursive: true });
  const record: LockRecord = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: Date.now(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readHolder(lockPath);
      // A record with no host came from this machine, so it is reclaimable.
      const sameHost =
        !!holder && (!holder.hostname || holder.hostname === record.hostname);
      // Only reclaim a lock this host owns and whose process is gone. A lock
      // from another host is never reclaimed, because this process cannot see
      // that host's process table.
      if (sameHost && holder && !isProcessAlive(holder.pid)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another process reclaimed it first; fall through to the retry.
        }
        continue;
      }
      throw new StateLockedError(lockPath, holder);
    }
    try {
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }
    return record;
  }
  throw new StateLockedError(lockPath, readHolder(lockPath));
}

/**
 * Release a lock this process owns.
 *
 * Releasing is best-effort and never throws: a stale lock is reclaimed on the
 * next start, so a failure here must not mask the caller's own shutdown error.
 */
export function releaseStateLock(statePath: string, record?: LockRecord) {
  const lockPath = lockPathFor(statePath);
  const holder = readHolder(lockPath);
  if (holder && record && holder.pid !== record.pid) return;
  if (holder && !record && holder.pid !== process.pid) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already released, or the directory was removed underneath us.
  }
}

/** The lock path a given state directory would use. */
export function stateLockPath(statePath: string) {
  return join(
    dirname(statePath),
    `${statePath.split(/[\\/]/).pop()}${LOCK_SUFFIX}`,
  );
}
