import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileWorkspace, memoryWorkspace } from './helpers/workspace.js';
import type { WorkspaceStore } from '../src/server/workspace.js';

const states: { close(): void }[] = [];
const dirs: string[] = [];

async function workspace() {
  const opened = await memoryWorkspace();
  states.push(opened.state);
  return opened.store;
}

/**
 * A file-backed workspace plus a `reopen` that reads the same directory again.
 *
 * Both handles matter: closing releases the process lock, which is what lets
 * the path be opened at all. `reopen` closes the first handle itself.
 */
function durableWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-felt-'));
  dirs.push(dir);
  const first = fileWorkspace(join(dir, 'state'));
  states.push(first.state);
  return {
    store: first.store,
    async reopen() {
      first.close();
      const second = fileWorkspace(join(dir, 'state'));
      states.push(second.state);
      await second.store.bootstrap();
      return second.store;
    },
  };
}

/** A second Dot, so per-Dot scoping can be asserted. */
async function secondDot(ws: WorkspaceStore) {
  const space = (await ws.spaces())[0]!;
  const dot = await ws.createDot(
    space.id,
    'Second',
    'Another specialist.',
    true,
    true,
  );
  return dot.id;
}

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('page thread reservations', () => {
  it('reserves once and reports the lease holder', async () => {
    const ws = await workspace();
    const [page, dot] = [randomUUID(), (await ws.dots())[0]!.id];
    expect(await ws.pageThreads.thread(page, dot)).toBeUndefined();
    expect(await ws.pageThreads.reserveThread(page, dot, 'thread-a')).toBe(
      true,
    );
    expect(await ws.pageThreads.thread(page, dot)).toEqual({
      threadId: 'thread-a',
      ready: false,
    });
  });

  it('keeps the first thread id and refuses a second lease', async () => {
    const ws = await workspace();
    const [page, dot] = [randomUUID(), (await ws.dots())[0]!.id];
    await ws.pageThreads.reserveThread(page, dot, 'thread-a');
    // `INSERT OR IGNORE`: the offered id is discarded, and the live lease
    // makes the second attempt report false.
    expect(await ws.pageThreads.reserveThread(page, dot, 'thread-b')).toBe(
      false,
    );
    expect((await ws.pageThreads.thread(page, dot))!.threadId).toBe('thread-a');
  });

  it('lets exactly one concurrent caller take the lease', async () => {
    const ws = await workspace();
    const [page, dot] = [randomUUID(), (await ws.dots())[0]!.id];
    const attempts = await Promise.all([
      ws.pageThreads.reserveThread(page, dot, 'thread-a'),
      ws.pageThreads.reserveThread(page, dot, 'thread-b'),
      ws.pageThreads.reserveThread(page, dot, 'thread-c'),
    ]);
    // The lease is the mutual exclusion page-service depends on for its 409.
    expect(attempts.filter(Boolean)).toHaveLength(1);
  });

  it('refuses a thread already anchored in another page', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    const first = randomUUID();
    await ws.pageThreads.reserveThread(first, dot, 'shared-thread');
    // The UNIQUE(threadId) constraint: nothing is written for the second page.
    expect(
      await ws.pageThreads.reserveThread(randomUUID(), dot, 'shared-thread'),
    ).toBe(false);
  });

  it('refuses to lease a reservation that is already ready', async () => {
    const ws = await workspace();
    const [page, dot] = [randomUUID(), (await ws.dots())[0]!.id];
    await ws.pageThreads.reserveThread(page, dot, 'thread-a');
    await ws.pageThreads.finishThread(page, dot);
    expect(await ws.pageThreads.reserveThread(page, dot, 'thread-b')).toBe(
      false,
    );
  });

  it('releases a lease only while not ready, and resolves a ready thread', async () => {
    const ws = await workspace();
    const [page, dot] = [randomUUID(), (await ws.dots())[0]!.id];
    await ws.pageThreads.reserveThread(page, dot, 'thread-a');
    // Not ready yet, so a pending thread does not resolve to the page.
    expect(await ws.pageThreads.pageIdForThread('thread-a')).toBeUndefined();
    await ws.pageThreads.releaseThread(page, dot);
    expect(await ws.pageThreads.reserveThread(page, dot, 'thread-b')).toBe(
      true,
    );
    await ws.pageThreads.finishThread(page, dot);
    expect(await ws.pageThreads.pageIdForThread('thread-a')).toBe(page);
  });

  it('treats updates to a missing reservation as a no-op', async () => {
    const ws = await workspace();
    const [page, dot] = [randomUUID(), (await ws.dots())[0]!.id];
    await expect(
      ws.pageThreads.finishThread(page, dot),
    ).resolves.toBeUndefined();
    await expect(
      ws.pageThreads.releaseThread(page, dot),
    ).resolves.toBeUndefined();
  });

  it('survives a restart', async () => {
    const durable = durableWorkspace();
    const first = durable.store;
    await first.bootstrap();
    const [page, dot] = [randomUUID(), (await first.dots())[0]!.id];
    await first.pageThreads.reserveThread(page, dot, 'thread-a');
    await first.pageThreads.finishThread(page, dot);

    const second = await durable.reopen();
    expect(await second.pageThreads.thread(page, dot)).toEqual({
      threadId: 'thread-a',
      ready: true,
    });
    expect(await second.pageThreads.pageIdForThread('thread-a')).toBe(page);
  });
});
describe('task thread bindings', () => {
  it('binds a task to a conversation and reads it back', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    await ws.bindThread('conv-1', dot, 'One');
    expect(await ws.taskThread('task-1')).toBeUndefined();
    await ws.bindTask('task-1', 'conv-1');
    expect(await ws.taskThread('task-1')).toBe('conv-1');
  });

  it('refuses to rebind a task, as the SQLite primary key did', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    await ws.bindThread('conv-1', dot, 'One');
    await ws.bindTask('task-1', 'conv-1');
    await expect(ws.bindTask('task-1', 'conv-1')).rejects.toThrow(
      'already bound',
    );
    expect(await ws.taskThread('task-1')).toBe('conv-1');
  });

  it('lets one conversation host several tasks', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    await ws.bindThread('conv-1', dot, 'One');
    await ws.bindTask('task-1', 'conv-1');
    await ws.bindTask('task-2', 'conv-1');
    expect(await ws.taskThread('task-2')).toBe('conv-1');
  });

  it('refuses to bind a conversation this owner does not hold', async () => {
    const ws = await workspace();
    await expect(ws.bindTask('task-1', 'unknown')).rejects.toThrow();
  });

  it('survives a restart', async () => {
    const durable = durableWorkspace();
    const first = durable.store;
    await first.bootstrap();
    const dot = (await first.dots())[0]!.id;
    await first.bindThread('conv-1', dot, 'One');
    await first.bindTask('task-1', 'conv-1');

    expect(await (await durable.reopen()).taskThread('task-1')).toBe('conv-1');
  });
});

describe('captures', () => {
  async function withThread() {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    await ws.bindThread('conv-1', dot, 'One');
    return ws;
  }

  it('stores and replaces one capture per conversation', async () => {
    const ws = await withThread();
    expect(await ws.capture('conv-1')).toBeNull();
    await ws.saveCapture('conv-1', { text: 'first' });
    expect(await ws.capture('conv-1')).toEqual({ text: 'first' });
    // Upsert: the value is replaced, exactly as ON CONFLICT DO UPDATE did.
    await ws.saveCapture('conv-1', { text: 'second' });
    expect(await ws.capture('conv-1')).toEqual({ text: 'second' });
  });

  it('refuses a capture for a conversation this owner does not hold', async () => {
    const ws = await workspace();
    await expect(ws.saveCapture('unknown', {})).rejects.toThrow();
    await expect(ws.capture('unknown')).rejects.toThrow();
  });

  it('survives a restart', async () => {
    const durable = durableWorkspace();
    const second = durable.store;
    await second.bootstrap();
    await second.bindThread('conv-1', (await second.dots())[0]!.id, 'One');
    await second.saveCapture('conv-1', { text: 'kept', screenshot: 'data' });
    expect(await (await durable.reopen()).capture('conv-1')).toEqual({
      text: 'kept',
      screenshot: 'data',
    });
  });
});
describe('calls', () => {
  async function withThread() {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    await ws.bindThread('conv-1', dot, 'One');
    return ws;
  }

  it('creates, reads and ends a call', async () => {
    const ws = await withThread();
    const call = await ws.createCall('conv-1');
    expect(call.status).toBe('connecting');
    expect(call.endedAt).toBeNull();
    expect(call.transcript).toBe('');
    expect((await ws.call(call.id)).id).toBe(call.id);
    const ended = await ws.setCall(call.id, 'ended', 'Hello there');
    expect(ended.status).toBe('ended');
    expect(ended.endedAt).not.toBeNull();
  });

  it('does not reopen a call that already ended', async () => {
    const ws = await withThread();
    const call = await ws.createCall('conv-1');
    await ws.setCall(call.id, 'ended', 'first');
    // A late provider callback must not reopen it.
    const again = await ws.setCall(call.id, 'active', 'second');
    expect(again.status).toBe('ended');
    expect(again.transcript).toBe('first');
  });

  it('orders calls newest first and filters by conversation', async () => {
    const ws = await withThread();
    const dot = (await ws.dots())[0]!.id;
    await ws.bindThread('conv-2', dot, 'Two');
    const older = await ws.createCall('conv-1');
    const newer = await ws.createCall('conv-1');
    const rows = await ws.calls('conv-1');
    expect(rows.map((row) => row.id)).toEqual([newer.id, older.id]);
    const stamps = rows.map((row) => row.startedAt);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    const other = await ws.createCall('conv-2');
    expect((await ws.calls('conv-2')).map((row) => row.id)).toEqual([other.id]);
  });

  it('reports a missing call rather than returning undefined', async () => {
    const ws = await withThread();
    await expect(ws.call('nope')).rejects.toThrow('Call not found.');
  });

  it('writes a late transcript exactly once', async () => {
    const ws = await withThread();
    const call = await ws.createCall('conv-1');
    await ws.setCall(call.id, 'ended', '');
    // The compare-and-set: only one writer changes anything.
    const raced = await Promise.all([
      ws.saveLateTranscript(call.id, 'late A'),
      ws.saveLateTranscript(call.id, 'late B'),
    ]);
    expect(raced.filter(Boolean)).toHaveLength(1);
    expect((await ws.call(call.id)).transcript).toMatch(/^late /);
  });

  it('refuses a late transcript before the call ended', async () => {
    const ws = await withThread();
    const call = await ws.createCall('conv-1');
    expect(await ws.saveLateTranscript(call.id, 'too soon')).toBe(false);
  });

  it('anchors a call, records an error, and leaks no storage metadata', async () => {
    const ws = await withThread();
    const call = await ws.createCall('conv-1');
    await ws.anchorCall(call.id, 'message-7');
    expect((await ws.call(call.id)).anchorMessageId).toBe('message-7');
    await ws.setCallError(call.id, 'provider dropped');
    expect((await ws.call(call.id)).error).toBe('provider dropped');
    expect(await ws.call(call.id)).not.toHaveProperty('__version');
    // An unanchored call never carries the optional field at all.
    const other = await ws.createCall('conv-1');
    expect((await ws.call(other.id)).anchorMessageId).toBeUndefined();
  });

  it('survives a restart', async () => {
    const durable = durableWorkspace();
    const first = durable.store;
    await first.bootstrap();
    const dot = (await first.dots())[0]!.id;
    await first.bindThread('conv-1', dot, 'One');
    const call = await first.createCall('conv-1');
    await first.setCall(call.id, 'ended', 'transcript');
    await first.anchorCall(call.id, 'message-9');

    const restored = (await (await durable.reopen()).call(call.id))!;
    expect(restored.status).toBe('ended');
    expect(restored.transcript).toBe('transcript');
    expect(restored.anchorMessageId).toBe('message-9');
  });
});
describe('computer permissions', () => {
  it('defaults every permission off', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    expect(await ws.computers.permissions(dot)).toEqual({
      enabled: false,
      browser: false,
      files: false,
      shell: false,
    });
  });

  it('merges a patch over the stored policy', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    expect(await ws.computers.patch(dot, { enabled: true })).toEqual({
      enabled: true,
      browser: false,
      files: false,
      shell: false,
    });
    // A second patch merges rather than replaces.
    expect(await ws.computers.patch(dot, { files: true })).toEqual({
      enabled: true,
      browser: false,
      files: true,
      shell: false,
    });
  });

  it('keeps every field when concurrent patches race', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    await Promise.all([
      ws.computers.patch(dot, { browser: true }),
      ws.computers.patch(dot, { files: true }),
    ]);
    const policy = await ws.computers.permissions(dot);
    // The fence is what stops one writer losing the other's field.
    expect(policy.browser).toBe(true);
    expect(policy.files).toBe(true);
  });

  it('leaks no storage metadata', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    await ws.computers.patch(dot, { enabled: true });
    expect(await ws.computers.permissions(dot)).not.toHaveProperty('__version');
    expect(await ws.computers.permissions(dot)).not.toHaveProperty('dotId');
  });
});

describe('computer audit', () => {
  it('records a pending receipt and closes it', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    const id = await ws.computers.begin(dot, 'files_write', 'agent');
    expect((await ws.computers.audit(dot))[0]).toMatchObject({
      id,
      action: 'files_write',
      actor: 'agent',
      outcome: 'pending',
    });
    await ws.computers.finish(id, 'succeeded');
    expect((await ws.computers.audit(dot))[0]!.outcome).toBe('succeeded');
  });

  it('records a failure', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    const id = await ws.computers.begin(dot, 'exec', 'agent');
    await ws.computers.finish(id, 'failed');
    expect((await ws.computers.audit(dot))[0]!.outcome).toBe('failed');
  });

  it('ignores an unknown receipt rather than throwing', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    await expect(
      ws.computers.finish('nope', 'failed'),
    ).resolves.toBeUndefined();
    expect(await ws.computers.audit(dot)).toEqual([]);
  });

  it('reads newest first', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    for (const action of ['navigate', 'read', 'snapshot']) {
      await ws.computers.finish(
        await ws.computers.begin(dot, action, 'owner'),
        'succeeded',
      );
    }
    const rows = await ws.computers.audit(dot);
    const stamps = rows.map((row) => row.createdAt);
    // The guarantee is descending `createdAt`, as `ORDER BY createdAt DESC`
    // gave; SQLite left the order of equal timestamps unspecified.
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
    expect(rows.map((row) => row.action).sort()).toEqual([
      'navigate',
      'read',
      'snapshot',
    ]);
  });

  it('keeps audit rows scoped to their own Dot', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    const other = await secondDot(ws);
    await ws.computers.finish(
      await ws.computers.begin(dot, 'navigate', 'owner'),
      'succeeded',
    );
    expect(await ws.computers.audit(other)).toEqual([]);
  });

  it('caps the read window at 50 rows', async () => {
    const ws = await workspace();
    const dot = (await ws.dots())[0]!.id;
    for (let i = 0; i < 55; i++)
      await ws.computers.finish(
        await ws.computers.begin(dot, 'read', 'owner'),
        'succeeded',
      );
    expect(await ws.computers.audit(dot)).toHaveLength(50);
  });

  it('survives a restart', async () => {
    const durable = durableWorkspace();
    const first = durable.store;
    await first.bootstrap();
    const dot = (await first.dots())[0]!.id;
    await first.computers.patch(dot, { enabled: true, shell: true });
    const id = await first.computers.begin(dot, 'exec', 'agent');
    await first.computers.finish(id, 'failed');

    const second = await durable.reopen();
    expect(await second.computers.permissions(dot)).toEqual({
      enabled: true,
      browser: false,
      files: false,
      shell: true,
    });
    expect((await second.computers.audit(dot))[0]).toMatchObject({
      action: 'exec',
      outcome: 'failed',
    });
  });
});
