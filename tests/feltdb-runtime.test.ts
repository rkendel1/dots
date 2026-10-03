import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFeltDB } from '@feltdb/core';
import type { StateFirstDB } from '@feltdb/core';

const child = fileURLToPath(
  new URL('./fixtures/feltdb-child.ts', import.meta.url),
);

interface ChildOutcome {
  label: string;
  opened?: boolean;
  closed?: boolean;
  ids?: string[];
  error?: string;
}

function runChild(
  mode: string,
  args: string[],
): Promise<{
  code: number | null;
  signal: string | null;
  outcome: ChildOutcome;
}> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', child, mode, ...args],
      { cwd: process.cwd() },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => (stdout += chunk));
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      let outcome: ChildOutcome;
      try {
        outcome = JSON.parse(stdout) as ChildOutcome;
      } catch {
        outcome = { label: '', error: stderr.slice(0, 400) };
      }
      resolve({ code, signal, outcome });
    });
  });
}

/** A record shape that keeps the probe assertions type-safe. */
interface Row {
  id?: string | number;
  __version?: number;
  title?: string;
  body?: string;
  writer?: string;
  n?: number;
  keep?: string;
  meta?: { a: { b: number[] } };
  [key: string]: unknown;
}

const dirs: string[] = [];
const opened: StateFirstDB[] = [];

function fileDb(namespace = 'probe') {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-felt-'));
  dirs.push(dir);
  const db = createFeltDB({ namespace, path: join(dir, 'state') });
  opened.push(db);
  return { db, path: join(dir, 'state'), dir };
}

/** Every probe uses a typed `pages` collection, so assertions stay type-safe. */
function pagesOf(db: StateFirstDB) {
  return db.collection<Row>('pages');
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('FeltDB runtime contract', () => {
  it('reports a durable file runtime when given a path', () => {
    const { db } = fileDb();
    const runtime = db.runtime();
    expect(runtime.storage).toBe('file');
    expect(runtime.persistent).toBe(true);
    expect(runtime.durable).toBe(true);
    expect(runtime.reactive).toBe(true);
  });

  it('reports a non-durable memory runtime for the in-memory option', () => {
    const db = createFeltDB({ namespace: 'probe', memory: true });
    opened.push(db);
    expect(db.runtime().storage).toBe('memory');
    expect(db.runtime().persistent).toBe(false);
    expect(db.runtime().durable).toBe(false);
  });

  it('returns the same collection instance for repeated name lookups', () => {
    const { db } = fileDb();
    expect(pagesOf(db)).toBe(pagesOf(db));
  });

  it('persists records across close and reopen', async () => {
    const { db, path } = fileDb();
    await pagesOf(db).insert({ title: 'Kept' }, 'p1');
    db.close();
    opened.length = 0;

    const reopened = createFeltDB({ namespace: 'probe', path });
    opened.push(reopened);
    expect(await pagesOf(reopened).get('p1')).toMatchObject({
      id: 'p1',
      title: 'Kept',
    });
  });
});

describe('FeltDB read semantics', () => {
  it('returns null for a missing record and false for exists', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    expect(await pages.get('nope')).toBeNull();
    expect(await pages.exists('nope')).toBe(false);
  });

  it('returns an empty array and zero count for an unused collection', async () => {
    const { db } = fileDb();
    const fresh = db.collection('never-written');
    expect(await fresh.all()).toEqual([]);
    expect(await fresh.count()).toBe(0);
  });

  it('filters on multiple fields and matches nothing for unknown fields', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert({ spaceId: 's1', title: 'a' }, 'p1');
    await pages.insert({ spaceId: 's2', title: 'b' }, 'p2');
    expect((await pages.find({ spaceId: 's1' })).map((p) => p.id)).toEqual([
      'p1',
    ]);
    expect(
      (await pages.find({ spaceId: 's1', title: 'b' })).map((p) => p.id),
    ).toEqual([]);
    expect((await pages.find({ missing: 'x' })).map((p) => p.id)).toEqual([]);
  });

  it('distinguishes an explicit null from an absent field', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert({ parentId: null }, 'explicit');
    await pages.insert({}, 'absent');
    expect((await pages.find({ parentId: null })).map((p) => p.id)).toEqual([
      'explicit',
    ]);
    expect(
      (await pages.find({ parentId: undefined })).map((p) => p.id),
    ).toEqual(['absent']);
  });

  it('orders and limits results', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    for (const n of [3, 1, 2]) await pages.insert({ n }, `p${n}`);
    const asc = await pages.find(
      {},
      { orderBy: [{ field: 'n', direction: 'asc' }] },
    );
    expect(asc.map((p) => p.n)).toEqual([1, 2, 3]);
    const limited = await pages.find(
      {},
      { orderBy: [{ field: 'n', direction: 'asc' }], limit: 2 },
    );
    expect(limited.map((p) => p.n)).toEqual([1, 2]);
  });

  it('hands back detached copies, so mutating a read cannot corrupt state', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert({ title: 'original', keep: 'yes' }, 'p1');

    const single = await pages.get('p1');
    expect(single).not.toBeNull();
    single!.title = 'mutated';
    const listed = await pages.all();
    listed[0].title = 'also mutated';
    const found = await pages.find({});
    found[0].title = 'mutated again';

    expect(await pages.get('p1')).toMatchObject({ title: 'original' });
  });

  it('round-trips booleans, zero, empty strings, nesting, and unicode', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert(
      {
        flag: true,
        off: false,
        count: 0,
        blank: '',
        meta: { a: { b: [1, 2, 3] } },
        title: '🙂 ünïcödé 漢字',
        body: 'x'.repeat(100000),
      },
      'p1',
    );
    const page = await pages.get('p1');
    expect(page).toMatchObject({ flag: true, off: false, count: 0, blank: '' });
    expect(page?.meta).toEqual({ a: { b: [1, 2, 3] } });
    expect(page?.title).toBe('🙂 ünïcödé 漢字');
    expect(page?.body).toHaveLength(100000);
  });

  it('reads a numeric id through either its numeric or string form', async () => {
    const { db } = fileDb();
    await db.collection('rows').insert({ v: 1 }, 12345);
    expect(await db.collection('rows').get(12345)).toMatchObject({ id: 12345 });
    expect(await db.collection('rows').get('12345')).toMatchObject({
      id: 12345,
    });
  });
});
describe('FeltDB write semantics', () => {
  it('assigns __version starting at 1 and increments it on update', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert({ title: 'a' }, 'p1');
    expect((await pages.get('p1'))?.__version).toBe(1);
    await pages.update('p1', { title: 'b' });
    expect((await pages.get('p1'))?.__version).toBe(2);
  });

  it('F3: insert on an existing id overwrites wholesale and resets __version', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert({ title: 'a', keep: 'yes' }, 'p1');
    await pages.update('p1', { title: 'b' });
    await pages.insert({ title: 'c' }, 'p1');
    const page = await pages.get('p1');
    expect(page).toMatchObject({ title: 'c' });
    expect(page).not.toHaveProperty('keep');
    expect(page?.__version).toBe(1);
  });

  it('throws rather than silently succeeding when updating a missing record', async () => {
    const { db } = fileDb();
    await expect(pagesOf(db).update('nope', { title: 'x' })).rejects.toThrow(
      /not found/i,
    );
    expect(await pagesOf(db).count()).toBe(0);
  });

  it('throws rather than silently succeeding when deleting a missing record', async () => {
    const { db } = fileDb();
    await expect(pagesOf(db).delete('nope')).rejects.toThrow(/not found/i);
  });

  it('reports a version conflict instead of overwriting', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert({ title: 'a' }, 'p1');
    const current = await pages.get('p1');
    const ok = await pages.updateIfVersion('p1', current!.__version!, {
      title: 'b',
    });
    expect(ok.updated).toBe(true);
    expect(ok.item?.__version).toBe(2);

    const stale = await pages.updateIfVersion('p1', current!.__version!, {
      title: 'c',
    });
    expect(stale.updated).toBe(false);
    expect(stale.currentVersion).toBe(2);
    expect((await pages.get('p1'))?.title).toBe('b');
  });

  it('treats putIfAbsent as an idempotent create', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    const first = await pages.putIfAbsent('p1', { title: 'first' });
    expect(first.inserted).toBe(true);
    const second = await pages.putIfAbsent('p1', { title: 'second' });
    expect(second.inserted).toBe(false);
    expect((await pages.get('p1'))?.title).toBe('first');
    expect(await pages.count()).toBe(1);
  });

  it('re-creates a deleted id from version 1', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert({ title: 'a' }, 'p1');
    await pages.delete('p1');
    expect(await pages.get('p1')).toBeNull();
    await pages.insert({ title: 'b' }, 'p1');
    expect(await pages.get('p1')).toMatchObject({
      title: 'b',
      __version: 1,
    });
  });

  it('notifies subscribers of committed changes', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    const seen: number[] = [];
    const unsubscribe = pages.subscribe((items) => seen.push(items.length));
    await pages.insert({ title: 'a' }, 'p1');
    await pages.insert({ title: 'b' }, 'p2');
    expect(seen.at(-1)).toBe(2);
    unsubscribe();
  });
});

describe('FeltDB transaction semantics', () => {
  it('commits every staged operation or none of them', async () => {
    const { db } = fileDb();
    await db.transaction(async (tx) => {
      tx.collection('pages').set('p1', { title: 'a' });
      tx.collection('audit').set('a1', { what: 'created p1' });
    });
    expect(await pagesOf(db).get('p1')).toMatchObject({
      title: 'a',
    });
    expect(await db.collection('audit' as string).count()).toBe(1);
  });

  it('writes nothing when the staging callback throws', async () => {
    const { db } = fileDb();
    await expect(
      db.transaction(async (tx) => {
        tx.collection('pages').set('p1', { title: 'a' });
        tx.collection('audit').set('a1', { what: 'created p1' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await pagesOf(db).get('p1')).toBeNull();
    expect(await db.collection('audit' as string).count()).toBe(0);
  });

  it('F2: records staged inside a transaction carry no __version', async () => {
    const { db } = fileDb();
    await db.transaction(async (tx) => {
      tx.collection('pages').set('p1', { title: 'a' });
    });
    const page = await pagesOf(db).get('p1');
    expect(page).toMatchObject({ id: 'p1', title: 'a' });
    expect(page).not.toHaveProperty('__version');
  });

  it('replays a transaction id without applying it twice', async () => {
    const { db } = fileDb();
    const document = {
      transactionId: 'probe-replay',
      preconditions: [],
      operations: [{ collection: 'counters', id: 'c1', value: { n: 1 } }],
    };
    const first = await db.transaction(document);
    const second = await db.transaction(document);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it('enforces requireAbsent as an atomic create', async () => {
    const { db } = fileDb();
    await db.transaction({
      transactionId: 'probe-absent-1',
      preconditions: [{ collection: 'pages', id: 'p1', requireAbsent: true }],
      operations: [{ collection: 'pages', id: 'p1', value: { title: 'a' } }],
    });
    expect(await pagesOf(db).get('p1')).toMatchObject({
      title: 'a',
    });

    await expect(
      db.transaction({
        transactionId: 'probe-absent-2',
        preconditions: [{ collection: 'pages', id: 'p1', requireAbsent: true }],
        operations: [{ collection: 'pages', id: 'p2', value: { title: 'b' } }],
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await pagesOf(db).get('p2')).toBeNull();
  });

  it('fences a transaction on the version the caller read', async () => {
    const { db } = fileDb();
    const pages = pagesOf(db);
    await pages.insert({ title: 'a' }, 'p1');
    const current = await pages.get('p1');

    await expect(
      db.transaction({
        transactionId: 'probe-conflict',
        preconditions: [
          {
            collection: 'pages',
            id: 'p1',
            ifVersion: current!.__version! + 999,
          },
        ],
        operations: [
          { collection: 'pages', id: 'p1', value: { title: 'overwritten' } },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      failure: { predicate: 'version' },
    });
    expect((await pages.get('p1'))?.title).toBe('a');
  });
});

describe('FeltDB process boundaries', () => {
  it('F1: a second process can open and write the same path without being refused', async () => {
    const { db, path } = fileDb('opendots-felt-probe');
    await db
      .collection('pages')
      .insert({ writer: 'parent' }, 'written-by-parent');
    db.close();
    opened.length = 0;

    const second = await runChild('writer', [path, 'child']);

    // The installed runtime does NOT enforce the single-writer guarantee its
    // README describes. This test pins that behaviour so the application
    // keeps enforcing exclusivity itself rather than trusting the runtime.
    expect(second.outcome.opened).toBe(true);
    expect(second.outcome.error).toBeUndefined();
    expect(second.outcome.ids).toEqual([
      'written-by-child',
      'written-by-parent',
    ]);

    const reopened = createFeltDB({ namespace: 'opendots-felt-probe', path });
    opened.push(reopened);
    expect(await reopened.collection('pages' as string).count()).toBe(2);
  }, 60_000);

  it('survives SIGKILL with every acknowledged write intact', async () => {
    const { db, path } = fileDb('opendots-felt-probe');
    db.close();
    opened.length = 0;

    const crashed = await runChild('crash', [path]);
    expect(crashed.signal).toBe('SIGKILL');

    const reopened = createFeltDB({ namespace: 'opendots-felt-probe', path });
    opened.push(reopened);
    const rows = await pagesOf(reopened).all();
    // Every acknowledged insert survived the abrupt death, with no
    // duplicates, omissions, or partially-applied records.
    expect(rows.length).toBe(500);
    const ids = rows.map((row) => String(row.id));
    expect(new Set(ids).size).toBe(500);
    for (let index = 0; index < 500; index++) {
      expect(ids).toContain(`row-${index}`);
    }
  }, 120_000);
});
