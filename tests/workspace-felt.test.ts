import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { memoryWorkspace, fileWorkspace } from './helpers/workspace.js';
import {
  grantKey,
  pairKey,
  workspaceCollections,
} from '../src/server/workspace-collections.js';
import type { WorkspaceStore } from '../src/server/workspace.js';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

async function fixture(ownerId = 'owner') {
  const opened = await memoryWorkspace(ownerId);
  // Registered so a failed assertion cannot strand the runtime.
  cleanup.push(() => opened.state.close());
  return opened.store;
}

/**
 * Open a durable state for restart tests.
 *
 * Each call takes the process lock, so the caller must close the previous pair
 * before opening again. Both closes are registered so a failed assertion cannot
 * strand the lock and break a later test.
 */
function durable() {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-felt-'));
  const statePath = join(dir, 'state');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return () => {
    const handles = fileWorkspace(statePath);
    // Registered as well as called by the test, so a failed assertion cannot
    // strand the lock; `close()` is idempotent.
    cleanup.push(() => handles.close());
    return handles;
  };
}

/** The raw grants, so tests assert on the authoritative relationship itself. */
function grantsOf(store: WorkspaceStore) {
  return workspaceCollections(store.state).dotSpaceGrants.all();
}

/** The default Space plus a second one, for grant tests. */
async function twoSpaces(store: WorkspaceStore) {
  const [first] = await store.spaces();
  const second = await store.createSpace('Second', 'Another Space');
  return [first!, second] as const;
}

// ---------------------------------------------------------------- Spaces

it('creates, reads and lists Spaces in creation order', async () => {
  const store = await fixture();
  const before = (await store.spaces()).length;
  const space = await store.createSpace('Design', 'Design decisions');
  expect(space).toMatchObject({
    name: 'Design',
    description: 'Design decisions',
  });
  expect(typeof space.createdAt).toBe('number');
  // The storage fence never crosses the application boundary.
  expect(space).not.toHaveProperty('__version');
  const spaces = await store.spaces();
  expect(spaces).toHaveLength(before + 1);
  expect(spaces.map((s) => s.id)).toContain(space.id);
  // Ordered by createdAt, which raw insertion order would not guarantee.
  expect(spaces.map((s) => s.createdAt)).toEqual(
    [...spaces.map((s) => s.createdAt)].sort((a, b) => a - b),
  );
});

it('never exposes the fence and never stores membership on the Dot', async () => {
  const store = await fixture();
  for (const space of await store.spaces())
    expect(space).not.toHaveProperty('__version');
  for (const dot of await store.dots()) {
    expect(dot).not.toHaveProperty('__version');
    // Membership is derived from grants, so it exists only on the way out.
    expect(Array.isArray(dot.spaceIds)).toBe(true);
  }
}); // ------------------------------------------------------------------ Dots

it('creates, reads and lists Dots with derived Space membership', async () => {
  const store = await fixture();
  const [first, second] = await twoSpaces(store);
  const dot = await store.createDot(
    first!.id,
    'Scout',
    'Be concise',
    false,
    true,
  );
  expect(dot).toMatchObject({
    spaceId: first!.id,
    name: 'Scout',
    instructions: 'Be concise',
    researchAllowed: false,
    memoryAllowed: true,
    skillDeliveryEnabled: false,
    learningContainerId: null,
  });
  expect(dot.spaceIds).toEqual([first!.id]);

  const granted = await store.createDot(
    first!.id,
    'Both',
    'Two Spaces',
    true,
    true,
    [first!.id, second!.id],
  );
  expect(granted.spaceIds).toEqual([first!.id, second!.id].sort());
  const dots = await store.dots();
  expect(dots.map((d) => d.id)).toContain(dot.id);
  expect(dots.map((d) => d.id)).toContain(granted.id);
  expect(await store.dot(dot.id)).toMatchObject({ name: 'Scout' });
  expect(await store.dot('missing')).toBeNull();
});

it('updates a Dot and reports a missing Dot rather than leaking a storage error', async () => {
  const store = await fixture();
  const space = (await store.spaces())[0]!;
  const dot = await store.createDot(
    space.id,
    'Scout',
    'Be concise',
    false,
    true,
  );
  const updated = await store.updateDot(dot.id, {
    ...dot,
    name: 'Researcher',
    instructions: 'Find evidence',
    researchAllowed: true,
    memoryAllowed: false,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  expect(updated).toMatchObject({
    name: 'Researcher',
    instructions: 'Find evidence',
    researchAllowed: true,
    memoryAllowed: false,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  // Identity and creation time are stable across an update.
  expect(updated.createdAt).toBe(dot.createdAt);
  expect(updated.id).toBe(dot.id);
  await expect(
    store.updateDot('missing', {
      ...dot,
      name: 'x',
      instructions: 'y',
      researchAllowed: true,
      memoryAllowed: true,
    }),
  ).rejects.toThrow('Dot not found.');
});

it('de-duplicates the default Space from a Dot’s grant set', async () => {
  const store = await fixture();
  const space = (await store.spaces())[0]!;
  const dot = await store.createDot(space.id, 'Scout', 'Help', true, true, [
    space.id,
    space.id,
  ]);
  expect(dot.spaceIds).toEqual([space.id]);
  expect((await store.dot(dot.id))?.spaceIds).toEqual([space.id]);
  // This Dot plus the first-run Dot, one grant each.
  expect((await grantsOf(store)).length).toBe(2);
});

// ---------------------------------------------------------------- Grants

it('adds, derives and removes grants, and rejects a Dot without its default Space', async () => {
  const store = await fixture();
  const [first, second] = await twoSpaces(store);
  const dot = await store.createDot(first!.id, 'Scout', 'Help', true, true);

  await store.updateDot(dot.id, {
    ...dot,
    spaceIds: [first!.id, second!.id],
  });
  expect(await store.canAccessSpace(dot.id, second!.id)).toBe(true);
  expect((await store.dot(dot.id))?.spaceIds).toEqual(
    [first!.id, second!.id].sort(),
  );

  // Revocation deletes the grant rather than only hiding it.
  await store.updateDot(dot.id, { ...dot, spaceIds: [first!.id] });
  expect(await store.canAccessSpace(dot.id, second!.id)).toBe(false);
  expect((await store.dot(dot.id))?.spaceIds).toEqual([first!.id]);
  expect(
    (await grantsOf(store)).some((grant) => grant.spaceId === second!.id),
  ).toBe(false);

  await expect(
    store.updateDot(dot.id, { ...dot, spaceIds: [second!.id] }),
  ).rejects.toThrow('Space access must include a valid default destination.');
  await expect(
    store.createDot(first!.id, 'Bad', 'Help', true, true, ['missing']),
  ).rejects.toThrow('Space access must include a valid default destination.');
  // A Dot that does not exist cannot be authorized for anything.
  expect(await store.canAccessSpace('missing', first!.id)).toBe(false);
});

it('stores each grant once no matter how often it is requested', async () => {
  const store = await fixture();
  const [first, second] = await twoSpaces(store);
  const dot = await store.createDot(first!.id, 'Scout', 'Help', true, true, [
    first!.id,
    second!.id,
  ]);
  for (let attempt = 0; attempt < 3; attempt++)
    await store.updateDot(dot.id, {
      ...dot,
      spaceIds: [first!.id, second!.id],
    });
  const rows = (await grantsOf(store)).filter((row) => row.dotId === dot.id);
  expect(rows.map((row) => row.spaceId).sort()).toEqual(
    [first!.id, second!.id].sort(),
  );
});

it('derives a collision-free grant key from two arbitrary ids', () => {
  // Each part is length-prefixed before hashing, so a naive concatenation that
  // would join to the same string still yields different keys.
  expect(grantKey('ab', 'c')).not.toBe(grantKey('a', 'bc'));
  expect(grantKey('ab', 'c')).toBe(grantKey('ab', 'c'));
  // Ids carrying characters FeltDB rejects in a transaction id are still safe.
  expect(grantKey('dot with spaces/and:punct', 'a/b c')).toMatch(
    /^[0-9a-f]{64}$/,
  );
  expect(pairKey('a', 'b')).toHaveLength(64);
}); // -------------------------------------------------------- Thread bindings

it('binds, looks up and refuses to rebind a conversation', async () => {
  const store = await fixture();
  const dot = (await store.dots())[0]!;
  const binding = await store.bindThread('thread-1', dot.id, 'Design research');
  expect(binding).toMatchObject({
    id: 'thread-1',
    dotId: dot.id,
    ownerId: 'owner',
    title: 'Design research',
  });
  expect((await store.requireThread('thread-1')).id).toBe('thread-1');
  expect((await store.conversations()).map((t) => t.id)).toEqual(['thread-1']);
  // SQLite's primary key refused a duplicate id; create-only is preserved.
  await expect(store.bindThread('thread-1', dot.id, 'Second')).rejects.toThrow(
    'Conversation already exists.',
  );
  expect((await store.requireThread('thread-1')).title).toBe('Design research');
  await expect(store.requireThread('unknown')).rejects.toThrow(
    'Conversation does not belong to this Dot and owner.',
  );
  await expect(
    store.bindThread('thread-2', 'missing', 'Orphan'),
  ).rejects.toThrow('Dot not found.');
});

it('scopes conversation lookups to the owning workspace', async () => {
  const owner = await fixture('owner');
  const dot = (await owner.dots())[0]!;
  await owner.bindThread('thread-1', dot.id, 'Owned');
  const other = await fixture('someone-else');
  expect(await other.conversations()).toEqual([]);
  await expect(other.requireThread('thread-1')).rejects.toThrow(
    'Conversation does not belong to this Dot and owner.',
  );
});

it('freezes a conversation’s Learning container at binding time', async () => {
  const store = await fixture();
  const dot = (await store.dots())[0]!;
  await store.bindThread('before', dot.id, 'Before learning');
  await store.updateDot(dot.id, {
    ...dot,
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  expect((await store.requireThread('before')).learningContainerId).toBeNull();
  await store.bindThread('after', dot.id, 'After learning');
  expect((await store.requireThread('after')).learningContainerId).toBe(
    'research',
  );
});

it('lists conversations newest first', async () => {
  const store = await fixture();
  const dot = (await store.dots())[0]!;
  // Distinct timestamps: SQLite's `ORDER BY createdAt DESC` left same-ms ties
  // in an arbitrary order, so the ordering is only pinned with real gaps.
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(1_000);
  await store.bindThread('first', dot.id, 'First');
  now.mockReturnValue(2_000);
  await store.bindThread('second', dot.id, 'Second');
  now.mockRestore();
  expect((await store.conversations()).map((t) => t.id)).toEqual([
    'second',
    'first',
  ]);
});

// ----------------------------------------------------------- Restart

it('persists Spaces, Dots, grants and bindings across a restart', async () => {
  const open = durable();
  const first = open();
  await first.store.bootstrap();
  const everyday = (await first.store.spaces())[0]!;
  const extra = await first.store.createSpace('Launch', 'Ship it');
  const dot = await first.store.createDot(
    everyday.id,
    'Scout',
    'Help',
    true,
    true,
  );
  await first.store.updateDot(dot.id, {
    ...dot,
    spaceIds: [everyday.id, extra.id],
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  await first.store.bindThread('thread-1', dot.id, 'Bound');
  first.close();

  const second = open();
  expect(await second.store.spaces()).toHaveLength(2);
  const reopened = await second.store.dot(dot.id);
  expect(reopened).toMatchObject({
    name: 'Scout',
    learningContainerId: 'research',
    skillDeliveryEnabled: true,
  });
  expect(reopened!.spaceIds).toEqual([everyday.id, extra.id].sort());
  expect(await second.store.canAccessSpace(dot.id, extra.id)).toBe(true);
  expect((await second.store.requireThread('thread-1')).dotId).toBe(dot.id);
  // Bootstrapping an already-populated state duplicates nothing: the first-run
  // Dot plus the one created above.
  await second.store.bootstrap();
  expect(await second.store.spaces()).toHaveLength(2);
  expect(await second.store.dots()).toHaveLength(2);
}); // ----------------------------------------------------------- Atomicity

it('leaves no partial Dot when its grants cannot be written', async () => {
  const store = await fixture();
  const [first, second] = await twoSpaces(store);
  const dot = await store.createDot(first!.id, 'Scout', 'Help', true, true);
  const dotsBefore = await store.dots();
  const grantKeys = (await grantsOf(store))
    .map((grant) => grantKey(grant.dotId, grant.spaceId))
    .sort();

  // One invalid Space rejects the whole create, so nothing is half-written.
  await expect(
    store.createDot(first!.id, 'Bad', 'Help', true, true, [
      first!.id,
      'missing',
    ]),
  ).rejects.toThrow('Space access must include a valid default destination.');

  expect(await store.dots()).toEqual(dotsBefore);
  expect(
    (await grantsOf(store))
      .map((grant) => grantKey(grant.dotId, grant.spaceId))
      .sort(),
  ).toEqual(grantKeys);
  expect(await store.canAccessSpace('Bad', second!.id)).toBe(false);
  expect((await store.dots()).some((d) => d.name === 'Bad')).toBe(false);
  expect(dot.id).toBeTruthy();
});

it('rolls a rejected Dot update back so fields and grants stay consistent', async () => {
  const store = await fixture();
  const [first, second] = await twoSpaces(store);
  const dot = await store.createDot(first!.id, 'Scout', 'Help', true, true);
  await store.updateDot(dot.id, {
    ...dot,
    spaceIds: [first!.id, second!.id],
  });
  const grantsBefore = (await grantsOf(store)).length;

  // The name change is valid but the Space set is not, so nothing commits.
  await expect(
    store.updateDot(dot.id, {
      ...dot,
      name: 'Renamed',
      spaceIds: [second!.id],
    }),
  ).rejects.toThrow('Space access must include a valid default destination.');

  const after = await store.dot(dot.id);
  expect(after?.name).toBe('Scout');
  expect(after?.spaceIds).toEqual([first!.id, second!.id].sort());
  expect((await grantsOf(store)).length).toBe(grantsBefore);
  expect(await store.canAccessSpace(dot.id, second!.id)).toBe(true);
});

// ------------------------------------------------------- Concurrency

it('gives every concurrent Dot creation its own record and grants', async () => {
  const store = await fixture();
  const space = (await store.spaces())[0]!;
  const created = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.createDot(space.id, `Dot ${index}`, 'Help', true, true),
    ),
  );
  expect(new Set(created.map((dot) => dot.id)).size).toBe(8);
  expect(await store.dots()).toHaveLength(9); // 8 plus the first-run Dot
  const ids = new Set(created.map((dot) => dot.id));
  expect(
    (await grantsOf(store)).filter((grant) => ids.has(grant.dotId)),
  ).toHaveLength(8);
});

it('lets exactly one of two competing binds of the same thread id win', async () => {
  const store = await fixture();
  const [first, second] = await twoSpaces(store);
  const a = await store.createDot(first!.id, 'A', 'Help', true, true);
  const b = await store.createDot(second!.id, 'B', 'Help', true, true);
  const results = await Promise.allSettled([
    store.bindThread('shared', a.id, 'From A'),
    store.bindThread('shared', b.id, 'From B'),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  // Exactly one binding exists, owned by whichever Dot won the race.
  const shared = (await store.conversations()).filter(
    (thread) => thread.id === 'shared',
  );
  expect(shared).toHaveLength(1);
  expect([a.id, b.id]).toContain(shared[0]!.dotId);
});
