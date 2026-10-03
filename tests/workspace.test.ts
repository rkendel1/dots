import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { memoryWorkspace, fileWorkspace } from './helpers/workspace.js';

it('persists spaces, specialist permissions, and canonical thread ownership', async () => {
  const store = await memoryWorkspace();
  const space = await store.store.createSpace('Design', 'Design decisions');
  const dot = await store.store.createDot(
    space.id,
    'Scout',
    'Be concise',
    false,
    true,
  );
  await store.store.bindThread('thread-1', dot.id, 'Design research');
  expect((await store.store.requireThread('thread-1', dot.id)).ownerId).toBe(
    'owner',
  );
  await expect(
    store.store.requireThread('thread-1', 'another-dot'),
  ).rejects.toThrow();
  await expect(store.store.requireThread('unknown')).rejects.toThrow();
  expect((await store.store.dot(dot.id))?.researchAllowed).toBe(false);
  store.state.close();
});

it('rejects a dot in a nonexistent space and does not rebind an existing thread', async () => {
  const store = await memoryWorkspace();
  await expect(
    store.store.createDot('missing', 'Dot', 'Help', true, true),
  ).rejects.toThrow();
  const dots = await store.store.dots();
  await store.store.bindThread('one', dots[0]!.id, 'First');
  // SQLite's primary key refused a duplicate id; create-only is preserved.
  await expect(
    store.store.bindThread('one', dots[0]!.id, 'Second'),
  ).rejects.toThrow('Conversation already exists.');
  expect((await store.store.requireThread('one')).title).toBe('First');
  store.state.close();
});

it('keeps a revoked Space grant revoked across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-access-'));
  const path = join(dir, 'state');
  try {
    const first = fileWorkspace(path);
    await first.store.bootstrap();
    const original = (await first.store.spaces())[0]!;
    const next = await first.store.createSpace('New', '');
    const dot = await first.store.createDot(
      original.id,
      'Dot',
      'Help',
      true,
      true,
    );
    expect(await first.store.canAccessSpace(dot.id, next.id)).toBe(false);
    await expect(
      first.store.updateDot(dot.id, { ...dot, spaceIds: ['missing'] }),
    ).rejects.toThrow('Space access must include a valid default destination.');
    // The rejected update must not have moved the Dot or its grants.
    expect((await first.store.dot(dot.id))?.spaceIds).toEqual([original.id]);
    await first.store.bindThread('existing-thread', dot.id, 'Keep me');
    await first.store.updateDot(dot.id, {
      ...dot,
      spaceId: next.id,
      spaceIds: [next.id],
    });
    first.close();

    const reopened = fileWorkspace(path);
    expect((await reopened.store.dot(dot.id))?.spaceIds).toEqual([next.id]);
    expect(await reopened.store.canAccessSpace(dot.id, original.id)).toBe(
      false,
    );
    expect((await reopened.store.requireThread('existing-thread')).dotId).toBe(
      dot.id,
    );
    // A second bootstrap must not restore the revoked grant or duplicate the
    // first-run defaults.
    await reopened.store.bootstrap();
    expect(await reopened.store.canAccessSpace(dot.id, original.id)).toBe(
      false,
    );
    expect(await reopened.store.spaces()).toHaveLength(2);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
