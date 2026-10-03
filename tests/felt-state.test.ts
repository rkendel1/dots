import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
const host = hostname();
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MEMORY_STATE,
  StateLockedError,
  isProcessAlive,
  openFeltState,
  stateLockPath,
} from '../src/server/felt/state.js';

const lockChild = fileURLToPath(
  new URL('./fixtures/state-lock-child.ts', import.meta.url),
);

interface ChildOutcome {
  mode?: string;
  ready?: boolean;
  opened?: boolean;
  closed?: boolean;
  pid?: number;
  refused?: string;
  message?: string;
}

/**
 * The child streams `{"pid":N,"ready":true}` as soon as it holds the lock, and
 * writes the full outcome as a second line once it finishes.
 */
function parseChildOutput(stdout: string): ChildOutcome {
  const merged: ChildOutcome = {};
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      Object.assign(merged, JSON.parse(line) as ChildOutcome);
    } catch {
      // Ignore any non-JSON noise the runtime may emit.
    }
  }
  return merged;
}

function runChild(mode: string, path: string, holdMs?: string) {
  return new Promise<{ code: number | null; outcome: ChildOutcome }>(
    (resolve, reject) => {
      const proc = spawn(
        process.execPath,
        ['--import', 'tsx', lockChild, mode, path, ...(holdMs ? [holdMs] : [])],
        { cwd: process.cwd() },
      );
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => (stdout += chunk));
      proc.stderr.on('data', (chunk) => (stderr += chunk));
      proc.on('error', reject);
      proc.on('close', (code) => {
        resolve({ code, outcome: parseChildOutput(stdout) });
      });
    },
  );
}

/**
 * Start a child that opens the state and holds it, without waiting for it to
 * exit. Used to prove that a live holder blocks a second process.
 */
function startHolder(statePath: string, holdMs: number) {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', lockChild, 'hold', statePath, String(holdMs)],
    { cwd: process.cwd() },
  );
  let stdout = '';
  proc.stdout.on('data', (chunk) => (stdout += chunk));
  proc.stderr.resume();
  const exited = new Promise<number | null>((resolve) =>
    proc.on('close', (code) => resolve(code)),
  );
  return {
    proc,
    exited,
    /** Resolves with the child's self-reported pid once it has opened. */
    async pidWithin(timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = stdout.match(/"pid":(\d+)/);
        if (match) return Number(match[1]);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return 0;
    },
  };
}

const dirs: string[] = [];
const states: { close(): void }[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-state-'));
  dirs.push(dir);
  return dir;
}

function open(path: string, namespace = 'opendots-test') {
  const state = openFeltState({ path, namespace });
  states.push(state);
  return state;
}

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('openFeltState', () => {
  it('opens a durable file runtime and records its lock', () => {
    const state = open(join(tempDir(), 'state'));
    expect(state.db.runtime().storage).toBe('file');
    expect(state.db.runtime().persistent).toBe(true);
    expect(state.lock).toMatchObject({ pid: process.pid });
    expect(existsSync(state.lockPath)).toBe(true);
  });

  it('takes a lock beside the state directory, not inside it', () => {
    const dir = tempDir();
    const path = join(dir, 'state');
    const state = open(path);
    expect(state.lockPath).toBe(stateLockPath(path));
    expect(stateLockPath(path)).toBe(join(dir, 'state.lock'));
  });

  it('persists a collection across close and reopen', async () => {
    const path = join(tempDir(), 'state');
    const first = open(path);
    await first.db.collection('probe').insert({ kept: true }, 'p1');
    first.close();

    const second = open(path);
    expect(await second.db.collection('probe').get('p1')).toMatchObject({
      kept: true,
    });
  });

  it('opens an in-memory runtime without taking a lock', () => {
    const state = openFeltState({ memory: true });
    states.push(state);
    expect(state.path).toBe(MEMORY_STATE);
    expect(state.lock).toBeNull();
    expect(state.db.runtime().persistent).toBe(false);
    expect(existsSync(state.lockPath)).toBe(false);
  });

  it('treats the explicit :memory: path as in-memory', () => {
    const state = openFeltState({ path: MEMORY_STATE });
    states.push(state);
    expect(state.lock).toBeNull();
    expect(state.db.runtime().storage).toBe('memory');
  });

  it('is safe to close more than once', () => {
    const state = open(join(tempDir(), 'state'));
    state.close();
    expect(() => state.close()).not.toThrow();
  });

  it('releases the lock on close so another open succeeds', () => {
    const path = join(tempDir(), 'state');
    const first = open(path);
    expect(existsSync(stateLockPath(path))).toBe(true);
    first.close();
    expect(existsSync(stateLockPath(path))).toBe(false);
    expect(() => open(path)).not.toThrow();
  });

  it('refuses a second open of the same state in this process', () => {
    const path = join(tempDir(), 'state');
    open(path);
    expect(() => openFeltState({ path, namespace: 'opendots-test' })).toThrow(
      StateLockedError,
    );
  });

  it('releases the lock even when the runtime fails to open', () => {
    const path = join(tempDir(), 'state');
    // A file where the state directory belongs makes the runtime fail.
    writeFileSync(path, 'not a directory');
    expect(() => openFeltState({ path })).toThrow();
    expect(existsSync(stateLockPath(path))).toBe(false);
  });
});

describe('state lock', () => {
  it('records the owning pid on disk', () => {
    const path = join(tempDir(), 'state');
    const state = open(path);
    const record = JSON.parse(readFileSync(state.lockPath, 'utf8')) as {
      pid: number;
      hostname: string;
    };
    expect(record.pid).toBe(process.pid);
    expect(record.hostname).toBeTruthy();
    expect(state.lock?.pid).toBe(process.pid);
  });

  it('reclaims a lock whose owning process no longer exists', () => {
    const path = join(tempDir(), 'state');
    // A pid that cannot be running: 2^22 is above the default pid_max.
    writeFileSync(
      stateLockPath(path),
      JSON.stringify({ pid: 4194303, hostname: host, acquiredAt: 1 }),
    );
    expect(() => open(path)).not.toThrow();
    expect(JSON.parse(readFileSync(stateLockPath(path), 'utf8')).pid).toBe(
      process.pid,
    );
  });

  it('never reclaims a lock held on another host', () => {
    const path = join(tempDir(), 'state');
    writeFileSync(
      stateLockPath(path),
      JSON.stringify({
        pid: 4194303,
        hostname: 'some-other-host',
        acquiredAt: 1,
      }),
    );
    expect(() => open(path)).toThrow(StateLockedError);
  });

  it('treats an unreadable lock as held rather than reclaiming it', () => {
    const path = join(tempDir(), 'state');
    writeFileSync(stateLockPath(path), 'not json');
    expect(() => open(path)).toThrow(StateLockedError);
  });

  it('reports a live process as alive', () => {
    // Signal 0 performs the existence check without delivering a signal.
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(1)).toBe(true);
  });

  it('reports a non-running pid as not alive', () => {
    expect(isProcessAlive(4194303)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });
});

describe('state lock across processes', () => {
  it('refuses a second process while the first holds the state', async () => {
    const path = join(tempDir(), 'state');
    const holder = startHolder(path, 30_000);
    const pid = await holder.pidWithin(30_000);
    expect(pid).toBeGreaterThan(0);
    expect(existsSync(stateLockPath(path))).toBe(true);

    const second = await runChild('try', path);

    // FeltDB alone would have let this through (Phase 0, F1). The
    // application-level lock is what makes the second writer fail.
    expect(second.outcome.opened).toBe(false);
    expect(second.outcome.refused).toBe('StateLockedError');
    expect(second.outcome.message).toContain(String(pid));

    holder.proc.kill('SIGKILL');
    await holder.exited;
  }, 90_000);

  it('lets the next process start once the previous one exits cleanly', async () => {
    const path = join(tempDir(), 'state');
    const holder = startHolder(path, 50);
    await holder.exited;
    expect(existsSync(stateLockPath(path))).toBe(false);

    const second = await runChild('try', path);
    expect(second.outcome.opened).toBe(true);
    expect(second.outcome.closed).toBe(true);
  }, 90_000);

  it('reclaims the lock after the owning process dies without closing', async () => {
    const path = join(tempDir(), 'state');
    const holder = startHolder(path, 60_000);
    const pid = await holder.pidWithin(30_000);
    expect(pid).toBeGreaterThan(0);

    const refused = await runChild('try', path);
    expect(refused.outcome.refused).toBe('StateLockedError');

    // Kill the holder so it never runs its own release, leaving a stale lock.
    holder.proc.kill('SIGKILL');
    await holder.exited;
    expect(existsSync(stateLockPath(path))).toBe(true);
    expect(isProcessAlive(pid)).toBe(false);

    const after = await runChild('try', path);
    expect(after.outcome.opened).toBe(true);
    expect(after.outcome.closed).toBe(true);
  }, 120_000);
});
