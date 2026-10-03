import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openFeltState, type FeltState } from '../src/server/felt/state.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

/**
 * Phase 7 acceptance tests: FeltDB is the sole runtime authority.
 *
 * These exercise the claim that matters most — that OpenDots runs correctly with
 * no SQLite anywhere near it, and stays correct when a SQLite file is present but
 * hostile. Nothing here imports `node:sqlite`; the "corrupt database" fixtures are
 * byte garbage written with `writeFileSync`, which is simpler and stricter than
 * constructing a real one.
 *
 * Every test runs in its own temp directory rather than touching `data/`, so the
 * suite is safe in CI (PR §12) and cannot damage a developer checkout.
 */

const dirs: string[] = [];
const states: FeltState[] = [];

afterEach(() => {
  for (const state of states.splice(0)) state.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** An isolated sandbox holding both the state path and the legacy path. */
function sandbox(): { state: string; legacy: string; namespace: string } {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-phase7-'));
  dirs.push(dir);
  return {
    // Spelled out rather than defaulted: the point is that the runtime resolves
    // FeltDB from an explicit path with no legacy file beside it.
    state: join(dir, 'opendots-state'),
    legacy: join(dir, 'opendots.sqlite'),
    // Stable for the lifetime of the sandbox, so a "restart" is genuinely a
    // second process reopening the *same* collection namespace — which is what
    // production does. A per-call random namespace would make every restart read
    // a different namespace, so the persistence assertions below would no longer
    // prove the state came back; they would pass or fail for reasons that had
    // nothing to do with durability.
    namespace: `phase7-${dir.split('/').pop()}`,
  };
}

interface Opened {
  state: FeltState;
  store: Store;
  workspace: WorkspaceStore;
  close(): void;
}

/**
 * Start OpenDots' durable stack the way `src/server/index.ts` does.
 *
 * Deliberately mirrors the startup sequence — open state, construct the stores,
 * bootstrap the workspace defaults — because "it starts" is the claim under test,
 * not merely "the constructors do not throw".
 */
async function start(statePath: string, namespace: string): Promise<Opened> {
  const state = openFeltState({ path: statePath, namespace });
  states.push(state);
  const store = new Store(state.db);
  const workspace = new WorkspaceStore('owner', state.db);
  await workspace.bootstrap();
  let closed = false;
  return {
    state,
    store,
    workspace,
    close() {
      if (closed) return;
      closed = true;
      state.close();
    },
  };
}

/** Every collection the runtime owns, in one place. */
const COLLECTIONS = [
  'settings',
  'spaces',
  'dots',
  'dot_space_grants',
  'pages',
  'page_reviews',
  'thread_bindings',
  'page_threads',
  'page_thread_ids',
  'tasks',
  'task_threads',
  'runs',
  'task_events',
  'memories',
  'calls',
  'captures',
  'computer_permissions',
  'computer_audit',
] as const;
describe('A — fresh FeltDB, SQLite absent', () => {
  it('starts, bootstraps and serves every domain', async () => {
    const { state: statePath, legacy, namespace } = sandbox();
    expect(existsSync(legacy)).toBe(false);

    const app = await start(statePath, namespace);
    // Starting, and then working, must not have conjured a legacy database.
    expect(existsSync(legacy)).toBe(false);

    // settings — created on first read, the runtime's seed-once path.
    expect((await app.store.settings()).name).toBe('Dot');

    // spaces + dots, from the first-run defaults.
    const spaces = await app.workspace.spaces();
    const dots = await app.workspace.dots();
    expect(spaces.length).toBeGreaterThan(0);
    expect(dots.length).toBeGreaterThan(0);

    // grants — Dot/Space membership is derived from `dot_space_grants`.
    expect(dots[0]!.spaceIds.length).toBeGreaterThan(0);

    // tasks, runs and events.
    const task = await app.store.createTask('Look things up');
    expect((await app.store.task(task.id))!.prompt).toBe('Look things up');
    // A created task writes its first event in the same transaction.
    expect((await app.store.detail(task.id))!.events).toHaveLength(1);

    // memories.
    await app.store.saveMemory('Likes short answers.');
    expect(await app.store.memories()).toHaveLength(1);

    // threads, calls and captures.
    const conversation = await app.workspace.bindThread(
      randomUUID(),
      dots[0]!.id,
      'Chat',
    );
    expect(await app.workspace.conversations()).toHaveLength(1);
    const call = await app.workspace.createCall(conversation.id);
    expect(call.threadId).toBe(conversation.id);
    await app.workspace.saveCapture(conversation.id, { text: 'page body' });
    expect(await app.workspace.capture(conversation.id)).toEqual({
      text: 'page body',
    });

    // Every collection the runtime owns is reachable in this process.
    for (const collection of COLLECTIONS)
      expect(await app.state.db.collection(collection).all()).toBeDefined();
  });

  it('leaves no SQLite file behind after working', async () => {
    const { state: statePath, legacy, namespace } = sandbox();
    const app = await start(statePath, namespace);
    await app.store.settings();
    await app.store.saveMemory('x');
    expect(existsSync(legacy)).toBe(false);
  });
});

describe('B — migrated FeltDB state, SQLite absent', () => {
  it('reads state written by a previous process', async () => {
    const { state: statePath, legacy, namespace } = sandbox();
    const first = await start(statePath, namespace);
    const space = await first.workspace.createSpace(
      'Everyday',
      'A little space.',
    );
    const dot = await first.workspace.createDot(
      space.id,
      'Dot',
      'Be thoughtful.',
      true,
      true,
    );
    await first.store.saveMemory('remember this', 'mem-1');
    await first.store.createTask('Write a page');
    first.close();

    // The second process has no idea SQLite exists; it only sees the state.
    expect(existsSync(legacy)).toBe(false);
    const second = await start(statePath, namespace);
    expect((await second.workspace.spaces()).map((s) => s.id)).toContain(
      space.id,
    );
    expect((await second.workspace.dot(dot.id))!.name).toBe('Dot');
    expect(await second.store.memories()).toHaveLength(1);
    expect(await second.store.tasks()).toHaveLength(1);
    // A real restart: the first process released the lock, this one holds it.
    expect(second.state.lock).not.toBeNull();
  });
});
describe('C — SQLite present but ignored', () => {
  it('operates normally when a legacy file sits beside the state', async () => {
    const { state: statePath, legacy, namespace } = sandbox();
    // A perfectly valid SQLite header. The runtime must not care.
    const contents = Buffer.from('SQLite format 3\0', 'binary');
    writeFileSync(legacy, contents);
    expect(existsSync(legacy)).toBe(true);

    const app = await start(statePath, namespace);
    expect((await app.store.settings()).name).toBe('Dot');
    await app.store.saveMemory('works anyway');
    expect(await app.store.memories()).toHaveLength(1);
    // Never opened, so the bytes are untouched.
    expect(readFileSync(legacy)).toEqual(contents);
  });
});

describe('D — SQLite corrupt or hostile', () => {
  const HOSTILE: [string, Buffer][] = [
    ['random bytes', Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01])],
    ['a text file', Buffer.from('this is not a database\n', 'utf8')],
    ['an empty file', Buffer.alloc(0)],
    [
      'a truncated header',
      Buffer.concat([
        Buffer.from('SQLite format 3\0', 'binary'),
        Buffer.alloc(3),
      ]),
    ],
    // A valid header followed by the bytes of a completely different schema.
    [
      'stale legacy data',
      Buffer.concat([
        Buffer.from('SQLite format 3\0', 'binary'),
        Buffer.from('spaces dots tasks runs events memories', 'utf8'),
      ]),
    ],
  ];

  for (const [label, contents] of HOSTILE)
    it(`keeps using FeltDB when the legacy file is ${label}`, async () => {
      const { state: statePath, legacy, namespace } = sandbox();
      writeFileSync(legacy, contents);

      const app = await start(statePath, namespace);
      // A full round trip through FeltDB while the hostile file is present.
      const space = await app.workspace.createSpace('S', 'd');
      await app.workspace.createDot(space.id, 'D', 'i', true, true);
      await app.store.saveMemory('durable');
      await app.store.createTask('still works');

      // The seeded Space and Dot are there, plus the one just created.
      expect(await app.workspace.spaces()).toHaveLength(2);
      expect(await app.store.memories()).toHaveLength(1);
      expect(await app.store.tasks()).toHaveLength(1);
      // Untouched, because the runtime has no reason to have read it.
      expect(readFileSync(legacy)).toEqual(contents);
    });

  it('keeps using FeltDB when the legacy path is a directory', async () => {
    const { state: statePath, legacy, namespace } = sandbox();
    // A path that exists but could never be opened as a database file.
    mkdirSync(legacy);
    const app = await start(statePath, namespace);
    expect((await app.store.settings()).name).toBe('Dot');
    await app.store.saveMemory('unaffected');
    expect(await app.store.memories()).toHaveLength(1);
  });
});

describe('E — runtime writes survive a restart', () => {
  it('persists create, then update, across processes', async () => {
    const { state: statePath, namespace } = sandbox();

    // create → FeltDB
    const first = await start(statePath, namespace);
    const space = await first.workspace.createSpace('Everyday', 's');
    const dot = await first.workspace.createDot(
      space.id,
      'Original',
      'i',
      true,
      true,
    );
    const task = await first.store.createTask('First prompt');
    const memory = await first.store.saveMemory('first memory', 'mem-1');
    const conversation = await first.workspace.bindThread(
      randomUUID(),
      dot.id,
      'Chat',
    );
    const call = await first.workspace.createCall(conversation.id);
    first.close();

    // new process → read
    const second = await start(statePath, namespace);
    expect((await second.workspace.dot(dot.id))!.name).toBe('Original');
    expect((await second.store.task(task.id))!.prompt).toBe('First prompt');
    expect((await second.store.memories())[0]!.text).toBe('first memory');
    expect((await second.workspace.call(call.id))!.id).toBe(call.id);
    expect(memory.id).toBe('mem-1');

    // update → FeltDB. `updateDot` takes the whole owned field set, not a sparse
    // patch, so the unchanged fields are sent back as read.
    const updated = await second.workspace.updateDot(dot.id, {
      name: 'Renamed',
      instructions: 'i',
      researchAllowed: true,
      memoryAllowed: true,
    });
    expect(updated.name).toBe('Renamed');
    await second.store.saveMemory('second memory', 'mem-1');
    await second.store.action(task.id, 'pause');
    second.close();

    // new process → read the updated state
    const third = await start(statePath, namespace);
    expect((await third.workspace.dot(dot.id))!.name).toBe('Renamed');
    expect((await third.store.memories())[0]!.text).toBe('second memory');
    expect((await third.store.task(task.id))!.status).toBe('paused');
  });

  it('survives a restart with no legacy file anywhere in sight', async () => {
    // The strongest form of the claim: the only durable artifact is FeltDB.
    const { state: statePath, legacy, namespace } = sandbox();
    const first = await start(statePath, namespace);
    await first.store.saveMemory('only FeltDB', 'mem-1');
    first.close();
    expect(existsSync(legacy)).toBe(false);

    const second = await start(statePath, namespace);
    expect((await second.store.memories())[0]!.text).toBe('only FeltDB');
  });
});
