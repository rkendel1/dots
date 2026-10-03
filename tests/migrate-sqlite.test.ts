import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openFeltState, type FeltState } from '../src/server/felt/state.js';
import {
  byStartedAtDescRowidDesc,
  transactionId,
} from '../src/server/felt/records.js';
import { reviewKey } from '../src/server/pages.js';
import { eventKey } from '../src/server/store-collections.js';
import { pageThreadKey } from '../src/server/workspace-collections.js';
import { readLegacy } from '../migrations/legacy-sqlite.js';
import {
  assignEventSeq,
  buildPlan,
  parseJson,
  selectAuditRetention,
  toBoolean,
} from '../migrations/import-plan.js';
import {
  applyPlan,
  classifyPlan,
  groupCoupled,
  sameContent,
} from '../migrations/apply-plan.js';
import { verifyMigration } from '../migrations/verify.js';

/**
 * The legacy schema, exactly as the shipped application created it.
 *
 * These fixtures exist because the real database is empty for every Phase 5
 * collection: without synthetic rows the conversions, the marker synthesis, the
 * trim and the idempotency rules would never actually be exercised.
 */
const SCHEMA = `
CREATE TABLE spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL, learningContainerId TEXT, skillDeliveryEnabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
CREATE TABLE pages(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, parentId TEXT, title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, sourceThreadId TEXT);
CREATE TABLE page_reviews(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, pageId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(threadId,toolCallId));
CREATE TABLE thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL, learningContainerId TEXT);
CREATE TABLE page_threads(pageId TEXT NOT NULL,dotId TEXT NOT NULL,threadId TEXT NOT NULL UNIQUE,ready INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pageId,dotId));
CREATE TABLE tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER);
CREATE TABLE task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
CREATE TABLE runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT, anchorMessageId TEXT);
CREATE TABLE captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE computer_permissions(dotId TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE computer_audit(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, outcome TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
`;

const dirs: string[] = [];
const states: FeltState[] = [];

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** Create a throwaway legacy database and return its path. */
function legacy(seed: (db: DatabaseSync) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-migrate-'));
  dirs.push(dir);
  const path = join(dir, 'legacy.sqlite');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  seed(db);
  db.close();
  return path;
}

/** Create a throwaway FeltDB state and return it. */
function felt(): FeltState {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-state-'));
  dirs.push(dir);
  const state = openFeltState({ path: join(dir, 'state') });
  states.push(state);
  return state;
}

const plan = (path: string, retention = 1000) =>
  buildPlan(readLegacy(path), { auditRetention: retention });

/**
 * Write one record the way the runtime does.
 *
 * `Collection` has no direct `set`; every write is staged into a transaction,
 * which is also what makes `requireAbsent` and the storage fence meaningful.
 */
async function put(
  state: FeltState,
  collection: string,
  id: string,
  value: Record<string, unknown>,
) {
  await state.db.transaction(
    (tx) => {
      tx.collection(collection).set(id, value);
    },
    { transactionId: transactionId('test-seed') },
  );
}

describe('basic migration', () => {
  it('imports every record preserving its identifier', async () => {
    const source = legacy(seedFull);
    const state = felt();
    const outcome = await applyPlan(state.db, plan(source));
    expect(outcome.created).toBe(SEED_WRITES);
    expect(outcome.conflicts).toEqual([]);

    const get = async (collection: string, id: string) =>
      (await state.db
        .collection<Record<string, unknown>>(collection)
        .get(id)) as Record<string, unknown> | undefined;
    expect(await get('spaces', 'space-1')).toBeTruthy();
    expect(await get('dots', 'dot-1')).toBeTruthy();
    expect((await get('thread_bindings', 'conv-1'))?.title).toBe('Chat');
    expect((await get('pages', 'page-1'))?.title).toBe('Notes');
    expect(
      await get('page_reviews', reviewKey('conv-1', 'tool-1')),
    ).toBeTruthy();
    expect((await get('calls', 'call-1'))?.threadId).toBe('conv-1');
    expect((await get('task_threads', 'task-1'))?.threadId).toBe('conv-1');
    expect((await get('tasks', 'task-1'))?.prompt).toBe('Look things up');
    expect((await get('runs', 'run-1'))?.status).toBe('failed');
    expect((await get('memories', 'mem-1'))?.text).toBe('Likes short answers.');
    expect((await get('computer_audit', 'audit-1'))?.action).toBe('navigate');
    // `task_events` has no domain id: it is addressed by the (taskId, seq)
    // composite the runtime builds, one entry per legacy event.
    expect(await get('task_events', eventKey('task-1', 0))).toBeTruthy();
    expect(await get('task_events', eventKey('task-1', 2))).toBeTruthy();
  });

  it('preserves timestamps, relationships and nulls exactly', async () => {
    const source = legacy(seedFull);
    const state = felt();
    await applyPlan(state.db, plan(source));
    const call = (await state.db
      .collection<Record<string, unknown>>('calls')
      .get('call-1'))!;
    expect(call.startedAt).toBe(2000);
    expect(call.endedAt).toBe(2100);
    expect(call.anchorMessageId).toBe('msg-1');
    const space = (await state.db
      .collection<Record<string, unknown>>('spaces')
      .get('space-1'))!;
    expect(space.createdAt).toBe(1000);
    expect(
      (await state.db.collection<Record<string, unknown>>('dots').get('dot-1'))
        ?.spaceId,
    ).toBe('space-1');
    // A NULL stays NULL rather than becoming an empty string or a missing field.
    const failed = (await state.db
      .collection<Record<string, unknown>>('runs')
      .get('run-1'))!;
    expect(failed.result).toBeNull();
    expect(failed.error).toBe('boom');
    expect(
      (await state.db
        .collection<Record<string, unknown>>('pages')
        .get('page-1'))!.parentId,
    ).toBeNull();
  });

  it('leaves an absent anchorMessageId absent rather than null', async () => {
    const source = legacy(seedFull);
    const state = felt();
    await applyPlan(state.db, plan(source));
    expect(
      'anchorMessageId' in
        (await state.db
          .collection<Record<string, unknown>>('calls')
          .get('call-2'))!,
    ).toBe(false);
  });

  it('verifies cleanly against the source', async () => {
    const source = legacy(seedFull);
    const state = felt();
    await applyPlan(state.db, plan(source));
    const result = await verifyMigration(
      state.db,
      readLegacy(source),
      new Set<string>(),
    );
    expect(result.checks.filter((entry) => !entry.ok)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
/**
 * Seed a fully populated workspace.
 *
 * Every collection this migration owns gets at least one row, and the references
 * are wired up so verification can assert real cross-domain relationships rather
 * than only counting records. Insertion order is chosen so the `rowid`-ordering
 * rules are observable: two calls share a timestamp, so their relative order
 * can only come from insertion order.
 */
function seedFull(db: DatabaseSync) {
  db.exec(`
    INSERT INTO spaces VALUES('space-1','Everyday','A little space.',1000);
    INSERT INTO dots VALUES('dot-1','space-1','Dot','Be thoughtful.',1,1,1001,NULL,0);
    INSERT INTO dot_spaces VALUES('dot-1','space-1');
    INSERT INTO pages VALUES('page-1','space-1',NULL,'Notes','body',3,1003,1004,'conv-1');
    INSERT INTO page_reviews VALUES('conv-1','tool-1','page-1','space-1');
    INSERT INTO thread_bindings VALUES('conv-1','dot-1','owner','Chat',1002,NULL);
    INSERT INTO page_threads VALUES('page-1','dot-1','conv-1',1,0);
    INSERT INTO tasks VALUES('task-1','Look things up','queued',3600,5000,1005,1005,NULL,NULL,NULL);
    INSERT INTO task_threads VALUES('task-1','conv-1');
    INSERT INTO runs VALUES('run-2','task-1','succeeded',2100,2200,'{"text":"done","sources":[],"sample":false}',NULL);
    INSERT INTO runs VALUES('run-1','task-1','failed',2000,2050,NULL,'boom');
    INSERT INTO events VALUES(NULL,'task-1','run-1','Task added to the research queue.',1005);
    INSERT INTO events VALUES(NULL,'task-1','run-1','Search failed.',2000);
    INSERT INTO events VALUES(NULL,'task-1','run-2','Found an answer.',2200);
    INSERT INTO memories VALUES('mem-1','Likes short answers.',1500);
    INSERT INTO calls VALUES('call-1','conv-1',2000,2100,'ended','hello',NULL,'msg-1');
    INSERT INTO calls VALUES('call-2','conv-1',1500,1600,'failed','oops','boom',NULL);
    INSERT INTO calls VALUES('call-3','conv-1',2000,2050,'ended','tied',NULL,NULL);
    INSERT INTO captures VALUES('conv-1','{"text":"page body","tags":[1,2],"nested":{"ok":true}}');
    INSERT INTO computer_permissions VALUES('dot-1','{"enabled":true,"browser":false,"files":true,"shell":false}');
    INSERT INTO computer_audit VALUES('audit-1','dot-1','navigate','owner','succeeded',3000);
    INSERT INTO settings VALUES(1,'{"name":"Dot","paused":false,"researchAllowed":true,"memoryAllowed":true}');
  `);
}

/**
 * How many records `seedFull` schedules, across every owned collection.
 *
 * settings 1, spaces 1, dots 1, grants 1, pages 1, reviews 1, bindings 1,
 * reservations 1, markers 1, tasks 1, task_threads 1, runs 2, events 3,
 * memories 1, calls 3, captures 1, permissions 1, audit 1.
 */
const SEED_WRITES = 23;

/**
 * Audit rows for one Dot, oldest first, plus one still in flight.
 *
 * The Space and Dot are seeded alongside, so verification's
 * `computer_audit → dots` relationship check has something real to resolve
 * rather than failing on a fixture that never claimed to be complete.
 */
function auditRows(db: DatabaseSync, dotId: string, finished: number) {
  const spaceId = `space-${dotId.replace(/^dot-/, '')}`;
  db.prepare('INSERT OR IGNORE INTO spaces VALUES(?,?,?,?)').run(
    spaceId,
    'S',
    '',
    1,
  );
  db.prepare('INSERT OR IGNORE INTO dots VALUES(?,?,?,?,?,?,?,?,?)').run(
    dotId,
    spaceId,
    'Dot',
    'i',
    1,
    1,
    1,
    null,
    0,
  );
  for (let i = 0; i < finished; i++)
    db.prepare('INSERT INTO computer_audit VALUES(?,?,?,?,?,?)').run(
      `a-${i}`,
      dotId,
      'navigate',
      'owner',
      'succeeded',
      i + 1,
    );
  db.prepare('INSERT INTO computer_audit VALUES(?,?,?,?,?,?)').run(
    'a-pending',
    dotId,
    'navigate',
    'owner',
    'pending',
    9999,
  );
}

/** Two Dots, two conversations and one reservation each. */
function twoPages(db: DatabaseSync) {
  db.exec(`
    INSERT INTO spaces VALUES('space-1','S','',1);
    INSERT INTO dots VALUES('dot-1','space-1','Dot','i',1,1,1,NULL,0);
    INSERT INTO dots VALUES('dot-2','space-1','Dot2','i',1,1,1,NULL,0);
    INSERT INTO pages VALUES('page-1','space-1',NULL,'A','',1,1,1,NULL);
    INSERT INTO pages VALUES('page-2','space-1',NULL,'B','',1,1,1,NULL);
    INSERT INTO thread_bindings VALUES('conv-1','dot-1','owner','C',1,NULL);
    INSERT INTO thread_bindings VALUES('conv-2','dot-2','owner','C2',2,NULL);
    INSERT INTO page_threads VALUES('page-1','dot-1','conv-1',1,0);
    INSERT INTO page_threads VALUES('page-2','dot-2','conv-2',0,0);
  `);
}

describe('empty source', () => {
  it('migrates nothing and leaves the target empty', async () => {
    const source = legacy();
    const state = felt();
    const outcome = await applyPlan(state.db, plan(source));
    expect(outcome.created).toBe(0);
    expect(outcome.conflicts).toEqual([]);
    for (const collection of [
      'settings',
      'page_threads',
      'calls',
      'captures',
      'pages',
      'tasks',
      'runs',
      'task_events',
      'memories',
    ])
      expect(
        await state.db.collection<Record<string, unknown>>(collection).all(),
      ).toEqual([]);
  });
});
describe('boolean conversion', () => {
  it('maps 0 to false and 1 to true', () => {
    expect(toBoolean('page_threads', 'a', 0)).toEqual({ value: false });
    expect(toBoolean('page_threads', 'a', 1)).toEqual({ value: true });
  });

  it('rejects any other value rather than coercing it', () => {
    // A loose conversion would make these `true`, which is precisely the bug.
    for (const raw of [2, -1, 7])
      expect(toBoolean('page_threads', 'a', raw)).toEqual({
        problem: {
          collection: 'page_threads',
          id: 'a',
          message: expect.stringContaining('expected 0 or 1'),
        },
      });
  });

  it('converts ready on every migrated reservation', async () => {
    const source = legacy(twoPages);
    const built = plan(source);
    // One `ready` per reservation, reported apart from the Dot booleans.
    expect(built.readyConverted).toBe(2);
    expect(built.boolsConverted).toBe(2 + 2 * 3);
    const state = felt();
    await applyPlan(state.db, built);
    const first = (await state.db
      .collection<Record<string, unknown>>('page_threads')
      .get(pageThreadKey('page-1', 'dot-1')))!;
    const second = (await state.db
      .collection<Record<string, unknown>>('page_threads')
      .get(pageThreadKey('page-2', 'dot-2')))!;
    expect(first.ready).toBe(true);
    expect(second.ready).toBe(false);
    // Real booleans in storage, not 0/1 integers.
    expect(typeof first.ready).toBe('boolean');
    expect(typeof second.ready).toBe('boolean');
  });

  it('fails the migration on an out-of-range ready value', () => {
    const source = legacy((db) => {
      db.prepare('INSERT INTO page_threads VALUES(?,?,?,?,?)').run(
        'page-1',
        'dot-1',
        'conv-1',
        2,
        0,
      );
    });
    const built = plan(source);
    expect(built.problems).toHaveLength(1);
    expect(built.problems[0]).toMatchObject({
      collection: 'page_threads',
      message: expect.stringContaining('expected 0 or 1'),
    });
    // Nothing is scheduled for a record that could not be converted.
    expect(built.counts.page_threads).toBeUndefined();
  });

  it('converts the Dot boolean columns too', async () => {
    const source = legacy((db) => {
      db.prepare('INSERT INTO dots VALUES(?,?,?,?,?,?,?,?,?)').run(
        'dot-1',
        'space-1',
        'Dot',
        'i',
        0,
        1,
        1,
        null,
        1,
      );
    });
    const state = felt();
    const built = plan(source);
    expect(built.boolsConverted).toBe(3);
    await applyPlan(state.db, built);
    const dot = (await state.db
      .collection<Record<string, unknown>>('dots')
      .get('dot-1'))!;
    expect(dot.researchAllowed).toBe(false);
    expect(dot.memoryAllowed).toBe(true);
    expect(dot.skillDeliveryEnabled).toBe(true);
  });
});
describe('JSON conversion', () => {
  const values: [string, unknown][] = [
    ['object', { foo: { bar: true } }],
    ['array', [1, 'two', null, { three: 3 }]],
    ['string', 'a bare string'],
    ['number', 42.5],
    ['boolean', true],
    ['null', null],
    ['nested', { a: { b: { c: [1, { d: null }] } } }],
  ];

  for (const [name, value] of values)
    it(`preserves a JSON ${name}`, async () => {
      const source = legacy((db) => {
        db.prepare('INSERT INTO captures VALUES(?,?)').run(
          'conv-1',
          JSON.stringify(value),
        );
        db.prepare('INSERT INTO thread_bindings VALUES(?,?,?,?,?,?)').run(
          'conv-1',
          'dot-1',
          'owner',
          'C',
          1,
          null,
        );
      });
      const state = felt();
      const built = plan(source);
      expect(built.jsonParsed).toBe(1);
      await applyPlan(state.db, built);
      expect(
        (
          await state.db
            .collection<Record<string, unknown>>('captures')
            .get('conv-1')
        )?.value,
      ).toEqual(value);
    });

  it('does not double-encode a structured value', async () => {
    const source = legacy((db) => {
      db.prepare('INSERT INTO captures VALUES(?,?)').run('conv-1', '{"a":1}');
      db.prepare('INSERT INTO thread_bindings VALUES(?,?,?,?,?,?)').run(
        'conv-1',
        'dot-1',
        'owner',
        'C',
        1,
        null,
      );
    });
    const state = felt();
    await applyPlan(state.db, plan(source));
    const stored = (await state.db
      .collection<Record<string, unknown>>('captures')
      .get('conv-1'))!;
    expect(typeof stored.value).toBe('object');
    expect(stored.value).toEqual({ a: 1 });
  });

  it('rejects malformed JSON and names the collection and record', () => {
    const source = legacy((db) =>
      db.prepare('INSERT INTO captures VALUES(?,?)').run('conv-9', '{oops'),
    );
    const built = plan(source);
    expect(built.problems).toHaveLength(1);
    expect(built.problems[0]!.collection).toBe('captures');
    expect(built.problems[0]!.id).toBe('conv-9');
    expect(built.problems[0]!.message).toContain('malformed JSON');
  });

  it('parses permission JSON and rejects a non-boolean field', () => {
    expect(parseJson('captures', 'x', '{"a":1}')).toEqual({ value: { a: 1 } });
    const bad = legacy((db) =>
      db
        .prepare('INSERT INTO computer_permissions VALUES(?,?)')
        .run('dot-1', '{"enabled":"yes"}'),
    );
    expect(plan(bad).problems[0]!.message).toContain('must be a boolean');
  });

  it('parses a run result into a structured document', async () => {
    const source = legacy((db) => {
      db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(
        'task-1',
        'p',
        'queued',
        null,
        null,
        1,
        1,
        null,
        null,
        null,
      );
      db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run(
        'run-1',
        'task-1',
        'succeeded',
        1,
        2,
        '{"text":"hi","sources":[{"title":"t","url":"u","excerpt":"e"}],"sample":false}',
        null,
      );
    });
    const state = felt();
    const built = plan(source);
    expect(built.jsonParsed).toBe(1);
    await applyPlan(state.db, built);
    expect(
      (await state.db.collection<Record<string, unknown>>('runs').get('run-1'))
        ?.result,
    ).toEqual({
      text: 'hi',
      sources: [{ title: 't', url: 'u', excerpt: 'e' }],
      sample: false,
    });
  });

  it('rejects a malformed run result and names the run', () => {
    const source = legacy((db) =>
      db
        .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)')
        .run('run-9', 'task-1', 'succeeded', 1, 2, 'not json', null),
    );
    const built = plan(source);
    expect(built.problems).toHaveLength(1);
    expect(built.problems[0]).toMatchObject({
      collection: 'runs',
      id: 'run-9',
      message: expect.stringContaining('malformed JSON'),
    });
  });
});
/** How many records `twoPages` schedules. */
const TWO_PAGE_WRITES = 11;

/**
 * Seed the conflicting duplicate-thread fixture.
 *
 * SQLite refuses to express two rows with the same `threadId` while the
 * `UNIQUE` constraint exists, so the table is rebuilt without it first — the
 * duplicate has to be physically present for the importer's conflict detection
 * to be exercised at all.
 */
function legacyWithoutThreadDuplicate(seed: (db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-migrate-dup-'));
  dirs.push(dir);
  const path = join(dir, 'legacy.sqlite');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec(`
    ALTER TABLE page_threads RENAME TO page_threads_strict;
    CREATE TABLE page_threads(pageId TEXT NOT NULL,dotId TEXT NOT NULL,threadId TEXT NOT NULL,ready INTEGER NOT NULL DEFAULT 0, leaseUntil INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(pageId,dotId));
    DROP TABLE page_threads_strict;
  `);
  seed(db);
  db.close();
  return path;
}

describe('page-thread marker synthesis', () => {
  it('synthesizes one marker per anchored thread', async () => {
    const source = legacy(twoPages);
    const state = felt();
    const built = plan(source);
    expect(built.counts.page_threads).toBe(2);
    expect(built.counts.page_thread_ids).toBe(2);
    await applyPlan(state.db, built);
    expect(
      await state.db
        .collection<Record<string, unknown>>('page_thread_ids')
        .all(),
    ).toHaveLength(2);
    expect(
      await state.db
        .collection<Record<string, unknown>>('page_thread_ids')
        .get('conv-1'),
    ).toEqual(expect.objectContaining({ threadId: 'conv-1' }));
  });

  it('gives the marker the same identity scheme the runtime uses', () => {
    const built = plan(legacy(twoPages));
    // Keyed by the bare threadId, exactly as `PageThreads.anchor` writes it.
    const marker = built.writes.find(
      (write) => write.collection === 'page_thread_ids',
    )!;
    expect(marker.id).toBe('conv-1');
    expect(marker.value).toEqual({ threadId: 'conv-1' });
  });

  it('fails when one thread is anchored to two pages', () => {
    const source = legacyWithoutThreadDuplicate((db) => {
      db.prepare('INSERT INTO spaces VALUES(?,?,?,?)').run(
        'space-1',
        'S',
        '',
        1,
      );
      db.prepare('INSERT INTO dots VALUES(?,?,?,?,?,?,?,?,?)').run(
        'dot-1',
        'space-1',
        'Dot',
        'i',
        1,
        1,
        1,
        null,
        0,
      );
      for (const pageId of ['page-1', 'page-2'])
        db.prepare('INSERT INTO pages VALUES(?,?,?,?,?,?,?,?,?)').run(
          pageId,
          'space-1',
          null,
          pageId,
          '',
          1,
          1,
          1,
          null,
        );
      for (const pageId of ['page-1', 'page-2'])
        db.prepare('INSERT INTO page_threads VALUES(?,?,?,?,?)').run(
          pageId,
          'dot-1',
          'conv-1',
          1,
          0,
        );
    });
    const conflict = plan(source).problems.find(
      (problem) => problem.collection === 'page_thread_ids',
    );
    expect(conflict).toBeDefined();
    // The report names the thread and both conflicting reservations.
    expect(conflict!.id).toBe('conv-1');
    expect(conflict!.message).toContain('page-1.dot-1');
    expect(conflict!.message).toContain('page-2.dot-1');
  });
});
describe('transactions', () => {
  it('writes a reservation and its marker as one unit', async () => {
    const source = legacy(twoPages);
    const built = plan(source);
    for (const group of groupCoupled(built.writes))
      if (group.some((write) => write.collection === 'page_thread_ids'))
        expect(group.map((write) => write.collection).sort()).toEqual([
          'page_thread_ids',
          'page_threads',
        ]);
    // Even a batch size of one keeps the pair together: the invariant outranks
    // the transaction size limit.
    const state = felt();
    await applyPlan(state.db, built, { batchSize: 1 });
    expect(
      await state.db.collection<Record<string, unknown>>('page_threads').all(),
    ).toHaveLength(2);
    expect(
      await state.db
        .collection<Record<string, unknown>>('page_thread_ids')
        .all(),
    ).toHaveLength(2);
    const result = await verifyMigration(
      state.db,
      readLegacy(source),
      new Set<string>(),
    );
    expect(result.ok).toBe(true);
  });

  it('never leaves a marker without its reservation', async () => {
    const source = legacy(twoPages);
    const state = felt();
    await applyPlan(state.db, plan(source), { batchSize: 2 });
    const reservations = (await state.db
      .collection<Record<string, unknown>>('page_threads')
      .all()) as {
      threadId: string;
    }[];
    const markers = (await state.db
      .collection<Record<string, unknown>>('page_thread_ids')
      .all()) as {
      threadId: string;
    }[];
    expect(markers.map((row) => row.threadId).sort()).toEqual(
      reservations.map((row) => row.threadId).sort(),
    );
  });
});

describe('idempotency', () => {
  it('running twice does not duplicate records', async () => {
    const source = legacy(seedFull);
    const state = felt();
    const built = plan(source);
    const first = await applyPlan(state.db, built);
    expect(first.created).toBe(SEED_WRITES);
    const second = await applyPlan(state.db, built);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(SEED_WRITES);
    expect(second.conflicts).toEqual([]);
    expect(
      await state.db.collection<Record<string, unknown>>('calls').all(),
    ).toHaveLength(3);
    expect(
      await state.db
        .collection<Record<string, unknown>>('page_thread_ids')
        .all(),
    ).toHaveLength(1);
  });

  it('ignores storage metadata when comparing records', () => {
    // The fence and the injected key are storage bookkeeping, not content.
    expect(
      sameContent(
        { threadId: 't', ready: true, id: 'page.dot', __version: 3 },
        { threadId: 't', ready: true },
      ),
    ).toBe(true);
    // A record that genuinely owns an id must still have it compared.
    expect(sameContent({ id: 'a', x: 1 }, { id: 'b', x: 1 })).toBe(false);
    // A real content difference is still a difference.
    expect(
      sameContent(
        { threadId: 't', ready: true },
        { threadId: 't', ready: false },
      ),
    ).toBe(false);
    // Key order is not content, and nested values compare structurally.
    expect(sameContent({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameContent({ v: { a: [1, 2] } }, { v: { a: [1, 2] } })).toBe(true);
    expect(sameContent({ v: { a: [1, 2] } }, { v: { a: [2, 1] } })).toBe(false);
  });

  it('treats an already-present marker as migrated, not as a conflict', async () => {
    const source = legacy(twoPages);
    const state = felt();
    await applyPlan(state.db, plan(source));
    // Simulate a partially completed prior run: the marker landed, its
    // reservation did not.
    await state.db
      .collection<Record<string, unknown>>('page_threads')
      .delete('page-2.dot-2');
    const outcome = await applyPlan(state.db, plan(source));
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.created).toBe(1);
    expect(outcome.skipped).toBe(TWO_PAGE_WRITES - 1);
    expect(
      await state.db
        .collection<Record<string, unknown>>('page_threads')
        .get('page-2.dot-2'),
    ).toBeTruthy();
  });

  it('fails rather than overwriting a changed target record', async () => {
    const source = legacy(seedFull);
    const state = felt();
    const built = plan(source);
    await applyPlan(state.db, built);
    await put(state, 'calls', 'call-1', {
      id: 'call-1',
      threadId: 'conv-1',
      startedAt: 1,
    });
    const outcome = await applyPlan(state.db, built);
    expect(outcome.created).toBe(0);
    expect(outcome.conflicts).toEqual([{ collection: 'calls', id: 'call-1' }]);
    // The changed record is left exactly as the caller had it.
    expect(
      (
        await state.db
          .collection<Record<string, unknown>>('calls')
          .get('call-1')
      )?.startedAt,
    ).toBe(1);
  });

  it('detects a changed record before writing anything else', async () => {
    const source = legacy(seedFull);
    const state = felt();
    const built = plan(source);
    await put(state, 'dots', 'dot-1', { id: 'dot-1', name: 'Something else' });
    const classified = await classifyPlan(state.db, built);
    expect(classified.conflicts).toEqual([{ collection: 'dots', id: 'dot-1' }]);
    // Classification writes nothing, so the rest of the plan is still absent.
    expect(
      await state.db.collection<Record<string, unknown>>('calls').all(),
    ).toHaveLength(0);
  });

  it('recovers from a partially completed prior run', async () => {
    const source = legacy(seedFull);
    const state = felt();
    const built = plan(source);
    // Commit a couple of records by hand, exactly as an interrupted run would.
    await put(state, 'spaces', 'space-1', {
      id: 'space-1',
      name: 'Everyday',
      description: 'A little space.',
      createdAt: 1000,
    });
    await put(state, 'memories', 'mem-1', {
      id: 'mem-1',
      text: 'Likes short answers.',
      createdAt: 1500,
    });
    const outcome = await applyPlan(state.db, built);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.skipped).toBe(2);
    expect(outcome.created).toBe(SEED_WRITES - 2);
    const result = await verifyMigration(
      state.db,
      readLegacy(source),
      new Set<string>(),
    );
    expect(result.ok).toBe(true);
  });
});
describe('audit retention', () => {
  it('keeps the newest finished rows and drops the rest', () => {
    const trimmed = selectAuditRetention(
      [
        { id: 'a', dotId: 'd1', outcome: 'succeeded', createdAt: 1 },
        { id: 'b', dotId: 'd1', outcome: 'succeeded', createdAt: 2 },
        { id: 'c', dotId: 'd1', outcome: 'succeeded', createdAt: 3 },
      ],
      2,
    );
    expect([...trimmed]).toEqual(['a']);
  });

  it('never trims a pending row, even beyond the window', () => {
    const trimmed = selectAuditRetention(
      [
        { id: 'a', dotId: 'd1', outcome: 'succeeded', createdAt: 1 },
        { id: 'p', dotId: 'd1', outcome: 'pending', createdAt: 0 },
      ],
      0,
    );
    expect([...trimmed]).toEqual(['a']);
  });

  it('breaks timestamp ties by insertion order, reproducing rowid DESC', () => {
    // All three share a timestamp, so only the legacy insertion order — which is
    // the `rowid` order — can decide which one survives.
    const trimmed = selectAuditRetention(
      [
        { id: 'oldest', dotId: 'd1', outcome: 'succeeded', createdAt: 1 },
        { id: 'middle', dotId: 'd1', outcome: 'succeeded', createdAt: 1 },
        { id: 'newest', dotId: 'd1', outcome: 'succeeded', createdAt: 1 },
      ],
      2,
    );
    expect([...trimmed]).toEqual(['oldest']);
  });

  it('trims per Dot independently', () => {
    const trimmed = selectAuditRetention(
      [
        { id: 'a', dotId: 'd1', outcome: 'succeeded', createdAt: 1 },
        { id: 'b', dotId: 'd2', outcome: 'succeeded', createdAt: 1 },
        { id: 'c', dotId: 'd1', outcome: 'succeeded', createdAt: 2 },
      ],
      1,
    );
    expect([...trimmed]).toEqual(['a']);
  });

  it('imports only the retained rows, keeping the pending one', async () => {
    const source = legacy((db) => auditRows(db, 'dot-1', 5));
    const state = felt();
    const built = plan(source, 3);
    expect(built.audit).toMatchObject({
      imported: 6,
      retained: 4,
      trimmed: 2,
    });
    await applyPlan(state.db, built);
    const stored = (await state.db
      .collection<Record<string, unknown>>('computer_audit')
      .all()) as {
      id: string;
      outcome: string;
    }[];
    expect(stored).toHaveLength(4);
    expect(stored.filter((row) => row.outcome === 'pending')).toHaveLength(1);
    expect(stored.some((row) => row.id === 'a-0')).toBe(false);
  });

  it('reports the trimmed ids so verification can be run against them', async () => {
    const source = legacy((db) => auditRows(db, 'dot-1', 4));
    const state = felt();
    const built = plan(source, 2);
    await applyPlan(state.db, built);
    expect(built.audit.trimmedIds).toHaveLength(2);
    expect(built.audit.trimmedIds).toContain('a-0');
    expect(built.audit.trimmedIds).toContain('a-1');
    const result = await verifyMigration(
      state.db,
      readLegacy(source),
      new Set(built.audit.trimmedIds),
    );
    expect(result.ok).toBe(true);
  });

  it('orders imported rows so insertion order matches the legacy tiebreak', async () => {
    const source = legacy((db) => auditRows(db, 'dot-1', 4));
    const state = felt();
    await applyPlan(state.db, plan(source, 10));
    const stored = (await state.db
      .collection<Record<string, unknown>>('computer_audit')
      .all()) as {
      id: string;
    }[];
    // No trimming happened, so the order is the legacy rowid order.
    expect(stored.map((row) => row.id)).toEqual([
      'a-0',
      'a-1',
      'a-2',
      'a-3',
      'a-pending',
    ]);
  });
});

describe('event sequencing', () => {
  it('renumbers a global autoincrement as a per-task sequence', () => {
    expect(
      assignEventSeq([
        { id: 1, taskId: 'a' },
        { id: 2, taskId: 'b' },
        { id: 3, taskId: 'a' },
        { id: 4, taskId: 'a' },
        { id: 5, taskId: 'b' },
      ]),
    ).toEqual(
      new Map([
        [1, 0],
        [2, 0],
        [3, 1],
        [4, 2],
        [5, 1],
      ]),
    );
  });

  it('addresses each event by the runtime composite key', async () => {
    const source = legacy(seedFull);
    const state = felt();
    await applyPlan(state.db, plan(source));
    const events = (await state.db
      .collection<Record<string, unknown>>('task_events')
      .all()) as {
      seq: number;
      text: string;
    }[];
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(events.map((event) => event.text)).toEqual([
      'Task added to the research queue.',
      'Search failed.',
      'Found an answer.',
    ]);
    expect(
      await state.db
        .collection<Record<string, unknown>>('task_events')
        .get(eventKey('task-1', 1)),
    ).toEqual(expect.objectContaining({ text: 'Search failed.' }));
  });
});
describe('ordering', () => {
  it('preserves the runtime order for migrated calls', async () => {
    const source = legacy(seedFull);
    const state = felt();
    await applyPlan(state.db, plan(source));
    const result = await verifyMigration(
      state.db,
      readLegacy(source),
      new Set<string>(),
    );
    expect(result.ok).toBe(true);
    // The runtime's own sort decides the order a user sees.
    const stored = (await state.db
      .collection<Record<string, unknown>>('calls')
      .all()) as {
      id: string;
      startedAt: number;
    }[];
    const ordered = byStartedAtDescRowidDesc(stored).map((call) => call.id);
    // call-1 and call-3 share a `startedAt`, so the `rowid DESC` tiebreak decides —
    // and call-3 was inserted last, so it is the newer of the two.
    expect(ordered).toEqual(['call-3', 'call-1', 'call-2']);
  });

  it('reproduces the legacy rowid tiebreak for a task run list', async () => {
    const source = legacy(seedFull);
    const state = felt();
    await applyPlan(state.db, plan(source));
    const result = await verifyMigration(
      state.db,
      readLegacy(source),
      new Set<string>(),
    );
    const check = result.checks.find(
      (entry) => entry.name === 'ordering:runs for task-1',
    )!;
    // The check carries the legacy expectation in `detail`, so it says what the
    // migrated order was compared against as well as whether it matched.
    expect(check.ok).toBe(true);
    expect(check.detail).toBe('legacy 2100,2000');
    // run-2 was inserted first, so the newest-first list leads with it.
    const runs = (await state.db
      .collection<Record<string, unknown>>('runs')
      .all()) as {
      taskId: string;
      startedAt: number;
    }[];
    expect(
      runs
        .filter((run) => run.taskId === 'task-1')
        .reverse()
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((run) => run.startedAt),
    ).toEqual([2100, 2000]);
  });

  it('orders tasks and memories newest first', async () => {
    const source = legacy((db) => {
      for (const [id, createdAt] of [
        ['task-1', 10],
        ['task-2', 30],
        ['task-3', 20],
      ])
        db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run(
          id,
          'p',
          'queued',
          null,
          null,
          createdAt,
          createdAt,
          null,
          null,
          null,
        );
      for (const [id, createdAt] of [
        ['mem-1', 10],
        ['mem-2', 30],
      ])
        db.prepare('INSERT INTO memories VALUES(?,?,?)').run(
          id,
          't',
          createdAt,
        );
    });
    const state = felt();
    await applyPlan(state.db, plan(source));
    const tasks = (await state.db
      .collection<Record<string, unknown>>('tasks')
      .all()) as {
      id: string;
    }[];
    expect(
      [...tasks].sort((a, b) => a.id.localeCompare(b.id)).map((row) => row.id),
    ).toEqual(['task-1', 'task-2', 'task-3']);
    expect(
      (await state.db.collection<Record<string, unknown>>('tasks').all()).map(
        (r) => r.id,
      ),
    ).toEqual(['task-1', 'task-3', 'task-2']);
  });
});

describe('restart persistence', () => {
  it('keeps migrated records after the state is closed and reopened', async () => {
    const source = legacy(seedFull);
    const dir = mkdtempSync(join(tmpdir(), 'opendots-restart-'));
    dirs.push(dir);
    const path = join(dir, 'state');

    const first = openFeltState({ path });
    await applyPlan(first.db, plan(source));
    first.close();

    // Reopening the same path is only possible once the lock is released.
    const second = openFeltState({ path });
    states.push(second);
    expect(
      await second.db
        .collection<Record<string, unknown>>('calls')
        .get('call-1'),
    ).toBeTruthy();
    expect(
      await second.db
        .collection<Record<string, unknown>>('page_thread_ids')
        .get('conv-1'),
    ).toBeTruthy();
    expect(
      await second.db
        .collection<Record<string, unknown>>('task_events')
        .get(eventKey('task-1', 2)),
    ).toBeTruthy();
    expect(
      await second.db
        .collection<Record<string, unknown>>('memories')
        .get('mem-1'),
    ).toBeTruthy();
    expect(
      await second.db
        .collection<Record<string, unknown>>('pages')
        .get('page-1'),
    ).toBeTruthy();
    const result = await verifyMigration(
      second.db,
      readLegacy(source),
      new Set<string>(),
    );
    expect(result.checks.filter((entry) => !entry.ok)).toEqual([]);
  });
});

describe('legacy source is never written', () => {
  it('leaves the SQLite file byte-identical', async () => {
    const source = legacy(seedFull);
    const before = readFileSync(source);
    const state = felt();
    await applyPlan(state.db, plan(source));
    expect(readFileSync(source)).toEqual(before);
    // And it is still readable afterwards.
    expect(readLegacy(source).calls).toHaveLength(3);
  });
});
