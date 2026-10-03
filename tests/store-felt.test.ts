import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fileStore,
  memoryStore,
  Store,
  type OpenStore,
} from './helpers/store.js';

const handles: OpenStore[] = [];
const dirs: string[] = [];

function store() {
  const handle = memoryStore();
  handles.push(handle);
  return handle.store;
}

/** A file-backed handle plus its directory, for restart tests. */
function durable() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-felt-'));
  dirs.push(dir);
  const handle = fileStore(join(dir, 'state'));
  handles.push(handle);
  return { ...handle, dir };
}

/** Reopen a durable path after its previous handle released the lock. */
function reopen(dir: string) {
  const handle = fileStore(join(dir, 'state'));
  handles.push(handle);
  return handle.store;
}

const sample = { text: 'Brief', sources: [], sample: true };

afterEach(() => {
  // Durable handles are closed before their directories are removed.
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('settings', () => {
  it('seeds defaults on first read', async () => {
    expect(await store().settings()).toEqual({
      name: 'Dot',
      paused: false,
      researchAllowed: true,
      memoryAllowed: true,
    });
  });
  it('persists settings across a restart', async () => {
    const first = durable();
    await first.store.updateSettings({ name: 'Sam', memoryAllowed: false });
    first.close();
    expect(await reopen(first.dir).settings()).toEqual({
      name: 'Sam',
      paused: false,
      researchAllowed: true,
      memoryAllowed: false,
    });
  });
  it('revoking research requeues running work and blocks new claims', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    const claim = (await s.claim(Date.now()))!;
    await s.updateSettings({ researchAllowed: false });
    expect((await s.task(task.id))?.status).toBe('queued');
    expect(await s.claim(Date.now())).toBeNull();
    // The interrupted worker cannot then overwrite the requeue.
    expect(await s.finish(claim, sample)).toBe(false);
  });
  it('revoking memory permission requeues running work', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    await s.claim(Date.now());
    await s.updateSettings({ memoryAllowed: false });
    expect((await s.task(task.id))?.status).toBe('queued');
  });
  it('keeps concurrent settings updates from losing a permission', async () => {
    const handle = memoryStore();
    handles.push(handle);
    await Promise.all([
      handle.store.updateSettings({ name: 'A' }),
      handle.store.updateSettings({ memoryAllowed: false }),
    ]);
    const settings = await handle.store.settings();
    // Neither writer may be lost to the other.
    expect(settings.name).toBe('A');
    expect(settings.memoryAllowed).toBe(false);
  });
});
describe('tasks', () => {
  it('creates, reads and updates a task', async () => {
    const s = store();
    const task = await s.createTask('Compare notebooks', 60);
    expect(task.status).toBe('queued');
    expect(task.intervalSeconds).toBe(60);
    expect(task.lease).toBeNull();
    expect((await s.task(task.id))?.prompt).toBe('Compare notebooks');
  });
  it('returns undefined for missing records instead of throwing', async () => {
    const s = store();
    // SQLite's SELECT and UPDATE on an absent row were silent no-ops.
    expect(await s.task('nope')).toBeUndefined();
    expect(await s.detail('nope')).toBeUndefined();
    expect(await s.action('nope', 'run')).toBeUndefined();
    expect(await s.schedule('nope', 60)).toBeUndefined();
    expect(await s.deleteMemory('nope')).toBe(false);
  });
  it('orders tasks newest first, keeping insertion order within a tie', async () => {
    const s = store();
    const first = await s.createTask('First');
    const second = await s.createTask('Second');
    const rows = await s.tasks();
    // The guarantee is descending `createdAt`, as `ORDER BY createdAt DESC` gave.
    expect(rows.map((task) => task.createdAt)).toEqual(
      [...rows.map((task) => task.createdAt)].sort((a, b) => b - a),
    );
    if (first.createdAt === second.createdAt) {
      // A shared millisecond is unordered in SQLite, so the stable sort keeps
      // insertion order rather than inventing one.
      expect(rows.map((task) => task.id)).toEqual([first.id, second.id]);
    }
  });
  it('treats run on a running task as a no-op', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    const claim = (await s.claim(Date.now()))!;
    const same = (await s.action(task.id, 'run'))!;
    expect(same.status).toBe('running');
    expect(same.lease).toBe(claim.lease);
    expect((await s.action(task.id, 'pause'))?.status).toBe('paused');
  });
  it('clears the pending repeat when the schedule is cleared', async () => {
    const s = store();
    const task = await s.createTask('Recurring', 60);
    await s.finish((await s.claim(Date.now()))!, sample);
    expect((await s.task(task.id))?.nextRunAt).not.toBeNull();
    const cleared = await s.schedule(task.id, null);
    expect(cleared?.intervalSeconds).toBeNull();
    expect(cleared?.nextRunAt).toBeNull();
  });
  it('only schedules a repeat from a completed task', async () => {
    const s = store();
    const task = await s.createTask('Recurring', 60);
    const claim = (await s.claim(Date.now()))!;
    // A running task has no completion to schedule from yet.
    const scheduled = await s.schedule(task.id, 60);
    expect(scheduled?.intervalSeconds).toBe(60);
    expect(scheduled?.nextRunAt).toBeNull();
    await s.finish(claim, sample);
    expect((await s.task(task.id))?.nextRunAt).not.toBeNull();
  });
});
describe('leases', () => {
  it('acquires a lease and opens a run whose id is the lease', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    const now = 1_000_000;
    const claim = (await s.claim(now))!;
    expect(claim.status).toBe('running');
    expect(claim.lease).toBeTruthy();
    expect(claim.leaseUntil).toBe(now + 180_000);
    expect(await s.owns(claim)).toBe(true);
    const detail = (await s.detail(task.id))!;
    expect(detail.runs).toHaveLength(1);
    expect(detail.runs[0]!.id).toBe(claim.lease);
    expect(detail.runs[0]!.status).toBe('running');
  });
  it('gives exactly one winner when three workers race for one task', async () => {
    const handle = memoryStore();
    handles.push(handle);
    await handle.store.createTask('Contended');
    const claims = await Promise.all([
      handle.store.claim(Date.now()),
      new Store(handle.state.db).claim(Date.now()),
      new Store(handle.state.db).claim(Date.now()),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  });
  it('claims every due task exactly once under contention', async () => {
    const handle = memoryStore();
    handles.push(handle);
    for (let i = 0; i < 4; i++) await handle.store.createTask(`Task ${i}`);
    // Eight contenders for four tasks, so the fencing has to hold, not luck.
    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Store(handle.state.db).claim(Date.now()),
      ),
    );
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(4);
    expect(new Set(winners.map((claim) => claim!.id)).size).toBe(4);
  });
  it('recovers an expired lease under a new lease', async () => {
    const s = store();
    const task = await s.createTask('Recover me');
    const now = Date.now();
    const old = (await s.claim(now))!;
    const recovered = (await s.claim(now + 180_001))!;
    expect(recovered.id).toBe(task.id);
    expect(recovered.lease).not.toBe(old.lease);
    expect(await s.owns(old)).toBe(false);
    expect(await s.finish(old, sample)).toBe(false);
    expect(await s.finish(recovered, sample)).toBe(true);
    const runs = (await s.detail(task.id))!.runs;
    expect(runs.some((run) => run.status === 'interrupted')).toBe(true);
  });
  it('recovers an expired lease after a restart', async () => {
    const first = durable();
    await first.store.createTask('Recover me');
    const now = Date.now();
    const old = (await first.store.claim(now))!;
    first.close();
    const recovered = (await reopen(first.dir).claim(now + 180_001))!;
    expect(recovered.id).toBe(old.id);
    expect(recovered.lease).not.toBe(old.lease);
  });
  it('releases a claim back to the queue', async () => {
    const s = store();
    const task = await s.createTask('Requeue me');
    const claim = (await s.claim(Date.now()))!;
    await s.release(claim, 'Server stopping; queued for restart.');
    const requeued = (await s.task(task.id))!;
    expect(requeued.status).toBe('queued');
    expect(requeued.lease).toBeNull();
    expect((await s.claim(Date.now()))?.id).toBe(task.id);
  });
  it('ignores a release from a superseded claim', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    const now = Date.now();
    const old = (await s.claim(now))!;
    const newer = (await s.claim(now + 180_001))!;
    await s.release(old, 'Stale worker stopping.');
    // The live claim keeps the task running.
    expect((await s.task(task.id))?.status).toBe('running');
    expect((await s.task(task.id))?.lease).toBe(newer.lease);
  });
  it('records a failed run', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    await s.fail((await s.claim(Date.now()))!, 'Model provider returned 500.');
    const failed = (await s.task(task.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Model provider returned 500.');
    expect(failed.lease).toBeNull();
    expect((await s.detail(task.id))!.runs[0]!.status).toBe('failed');
  });
});
describe('cancellation', () => {
  it('does not let a late result overwrite a cancellation', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    const claim = (await s.claim(Date.now()))!;
    await s.action(task.id, 'cancel');
    expect(await s.finish(claim, sample)).toBe(false);
    expect((await s.task(task.id))?.status).toBe('cancelled');
    // The run never reached a terminal state of its own.
    expect((await s.detail(task.id))!.runs[0]!.status).toBe('interrupted');
  });
  it('does not let a late failure overwrite a cancellation', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    const claim = (await s.claim(Date.now()))!;
    await s.action(task.id, 'cancel');
    await s.fail(claim, 'Boom');
    const cancelled = (await s.task(task.id))!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBeNull();
  });
  it('does not let a late worker overwrite a newer claim', async () => {
    const s = store();
    await s.createTask('Research one');
    const now = Date.now();
    const old = (await s.claim(now))!;
    const newer = (await s.claim(now + 180_001))!;
    expect(await s.finish(old, sample)).toBe(false);
    expect(await s.finish(newer, sample)).toBe(true);
  });
  it('records why a task was cancelled', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    await s.claim(Date.now());
    await s.action(task.id, 'cancel');
    const texts = (await s.detail(task.id))!.events.map((event) => event.text);
    expect(texts).toContain('Task cancelled.');
  });
});

describe('runs and events', () => {
  it('records a completed run and its result', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    await s.finish((await s.claim(Date.now()))!, sample);
    const run = (await s.detail(task.id))!.runs[0]!;
    expect(run.status).toBe('completed');
    expect(run.result).toEqual(sample);
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toBeNull();
  });
  it('orders runs newest first', async () => {
    const s = store();
    const task = await s.createTask('Recurring', 60);
    const now = Date.now();
    const first = (await s.claim(now))!;
    await s.finish(first, sample, now);
    const second = (await s.claim(now + 60_001))!;
    await s.finish(second, sample, now + 60_001);
    const runs = (await s.detail(task.id))!.runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]!.id).toBe(second.lease);
  });
  it('persists events in order across a restart', async () => {
    const first = durable();
    const task = await first.store.createTask('Research one');
    await first.store.event(task.id, null, 'Second');
    await first.store.event(task.id, null, 'Third');
    first.close();

    const events = (await reopen(first.dir).detail(task.id))!.events;
    expect(events.map((event) => event.text)).toEqual([
      'Task added to the research queue.',
      'Second',
      'Third',
    ]);
    // Sequence ids ascend and stay unique within the task.
    const ids = events.map((event) => event.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('keeps every concurrent event append', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => s.event(task.id, null, `Step ${i}`)),
    );
    const events = (await s.detail(task.id))!.events;
    // The creation event plus all eight appends survive, none overwritten.
    expect(events).toHaveLength(9);
    expect(new Set(events.map((event) => event.id)).size).toBe(9);
    expect(new Set(events.map((event) => event.text)).size).toBe(9);
  });
  it('attributes events to the run that produced them', async () => {
    const s = store();
    const task = await s.createTask('Research one');
    const claim = (await s.claim(Date.now()))!;
    await s.event(task.id, claim.lease, 'Working');
    await s.finish(claim, sample);
    const events = (await s.detail(task.id))!.events;
    expect(events.map((event) => event.text)).toEqual([
      'Task added to the research queue.',
      'Research worker started.',
      'Working',
      'Fictional sample brief ready.',
    ]);
    // Only the creation event predates the run.
    expect(events[0]!.runId).toBeNull();
    expect(events.slice(1).map((event) => event.runId)).toEqual([
      claim.lease,
      claim.lease,
      claim.lease,
    ]);
  });
});
describe('memories', () => {
  it('persists and deletes memories', async () => {
    const s = store();
    const first = await s.saveMemory('Prefer short briefs');
    const second = await s.saveMemory('Prefer deep briefs');
    const rows = await s.memories();
    expect(rows.map((memory) => memory.createdAt)).toEqual(
      [...rows.map((memory) => memory.createdAt)].sort((a, b) => b - a),
    );
    expect(rows.map((memory) => memory.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(await s.deleteMemory(first.id)).toBe(true);
    // Deleting twice reports false rather than throwing.
    expect(await s.deleteMemory(first.id)).toBe(false);
    expect(await s.memories()).toHaveLength(1);
  });
  it('preserves the original createdAt when a memory is re-saved', async () => {
    const s = store();
    const created = await s.saveMemory('Prefer short briefs', 'm1');
    const updated = await s.saveMemory('Prefer deep briefs', 'm1');
    // SQLite's upsert updated `text` only, so the memory keeps its place.
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.text).toBe('Prefer deep briefs');
    expect(await s.memories()).toHaveLength(1);
  });
  it('survives a restart', async () => {
    const first = durable();
    await first.store.saveMemory('Persisted preference', 'm1');
    first.close();
    expect((await reopen(first.dir).memories()).map((m) => m.text)).toEqual([
      'Persisted preference',
    ]);
  });
  it('keeps a concurrent re-save from losing the create', async () => {
    const handle = memoryStore();
    handles.push(handle);
    await Promise.all([
      handle.store.saveMemory('First writer', 'm1'),
      handle.store.saveMemory('Second writer', 'm1'),
    ]);
    const memories = await handle.store.memories();
    expect(memories).toHaveLength(1);
    expect(['First writer', 'Second writer']).toContain(memories[0]!.text);
  });
});

describe('restart persistence', () => {
  it('restores the whole task lifecycle', async () => {
    const first = durable();
    const task = await first.store.createTask('Compare notebooks', 60);
    const claim = (await first.store.claim(Date.now()))!;
    await first.store.event(task.id, claim.lease, 'Reading the page.');
    await first.store.finish(claim, sample);
    await first.store.saveMemory('Persisted preference', 'm1');
    first.close();

    const s = reopen(first.dir);
    const detail = (await s.detail(task.id))!;
    expect(detail.task.status).toBe('completed');
    expect(detail.runs[0]!.result).toEqual(sample);
    expect(detail.events.map((event) => event.text)).toEqual([
      'Task added to the research queue.',
      'Research worker started.',
      'Reading the page.',
      'Fictional sample brief ready.',
    ]);
    expect((await s.memories()).map((m) => m.text)).toEqual([
      'Persisted preference',
    ]);
  });
  it('refuses a second owner of the same state directory', () => {
    const first = durable();
    expect(() => fileStore(join(first.dir, 'state'))).toThrow();
  });
});
