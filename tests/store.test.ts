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

const open: OpenStore[] = [];
const dirs: string[] = [];

function memory() {
  const handle = memoryStore();
  open.push(handle);
  return handle.store;
}

function durable() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-'));
  dirs.push(dir);
  const handle = fileStore(join(dir, 'state'));
  open.push(handle);
  return { ...handle, dir };
}

afterEach(() => {
  // The durable handles are closed before their directories are removed.
  for (const handle of open.splice(0)) handle.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('durable task lifecycle', () => {
  it('persists tasks and settings across restarts', async () => {
    const first = durable();
    const task = await first.store.createTask(
      'Compare the sample notebooks',
      60,
    );
    await first.store.updateSettings({ name: 'Sam' });
    // The lock is released with the handle, which is what lets the same path
    // be reopened at all.
    first.close();

    const second = fileStore(join(first.dir, 'state'));
    open.push(second);
    expect((await second.store.task(task.id))?.prompt).toBe(task.prompt);
    expect((await second.store.settings()).name).toBe('Sam');
  });
  it('refuses a second owner of the same state directory', () => {
    const first = durable();
    expect(() => fileStore(join(first.dir, 'state'))).toThrow();
  });
  it('claims each due job once even through concurrent claimers', async () => {
    const handle = memoryStore();
    open.push(handle);
    await handle.store.createTask('Research one');
    // A second Store over the same state models a competing worker.
    const rival = new Store(handle.state.db);
    const claims = await Promise.all([
      handle.store.claim(1000),
      rival.claim(1000),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  });
  it('never overwrites a cancellation with a late result', async () => {
    const store = memory();
    const task = await store.createTask('Research one');
    const claim = (await store.claim(Date.now()))!;
    await store.action(task.id, 'cancel');
    expect(
      await store.finish(claim, {
        text: 'Late result',
        sources: [],
        sample: true,
      }),
    ).toBe(false);
    expect((await store.task(task.id))?.status).toBe('cancelled');
  });
  it('keeps recurring history and schedules only after completion', async () => {
    const store = memory();
    const task = await store.createTask('Recurring research', 60);
    const now = Date.now();
    const claim = (await store.claim(now))!;
    await store.finish(
      claim,
      { text: 'First result', sources: [], sample: true },
      now,
    );
    expect(await store.claim(now + 59_000)).toBeNull();
    expect((await store.claim(now + 60_001))?.id).toBe(task.id);
    expect((await store.detail(task.id))?.runs).toHaveLength(2);
  });
  it('global pause invalidates running leases and blocks queued jobs', async () => {
    const store = memory();
    const task = await store.createTask('Research one');
    const claim = (await store.claim(Date.now()))!;
    await store.updateSettings({ paused: true });
    expect(await store.claim(Date.now())).toBeNull();
    expect(
      await store.finish(claim, {
        text: 'Late result',
        sources: [],
        sample: true,
      }),
    ).toBe(false);
    await store.updateSettings({ paused: false });
    expect((await store.claim(Date.now()))?.id).toBe(task.id);
  });
  it('recovers expired work without duplicate completion', async () => {
    const store = memory();
    await store.createTask('Recover me');
    const now = Date.now();
    const old = (await store.claim(now))!;
    const recovered = (await store.claim(now + 180_001))!;
    expect(recovered.id).toBe(old.id);
    expect(recovered.lease).not.toBe(old.lease);
    expect(
      await store.finish(old, { text: 'Old', sources: [], sample: true }),
    ).toBe(false);
    expect(
      await store.finish(recovered, { text: 'New', sources: [], sample: true }),
    ).toBe(true);
  });
  it('recovers expired work after a restart', async () => {
    const first = durable();
    await first.store.createTask('Recover me');
    const now = Date.now();
    const old = (await first.store.claim(now))!;
    first.close();

    const second = fileStore(join(first.dir, 'state'));
    open.push(second);
    const recovered = (await second.store.claim(now + 180_001))!;
    expect(recovered.id).toBe(old.id);
    expect(recovered.lease).not.toBe(old.lease);
  });
});
