import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFeltState } from '../src/server/felt/state.js';
import { Pages } from '../src/server/pages.js';

/**
 * Exercise the page store directly.
 *
 * Spaces are still owned by WorkspaceStore (SQLite) until a later phase, so a
 * file-backed fixture declares which Space ids exist rather than seeding a
 * whole workspace.
 */
function durablePages() {
  const dir = mkdtempSync(join(tmpdir(), 'dots-pages-'));
  const state = openFeltState({ path: join(dir, 'state') });
  const pages = new Pages(state.db, () => true);
  return {
    dir,
    state,
    pages,
    close() {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const SPACE = 'space-1';

it('persists nested page content and revision across restart', async () => {
  const { dir, state, pages } = durablePages();
  const parent = await pages.create(SPACE, {
    title: 'Plan',
    content: 'A plan',
  });
  const child = await pages.create(SPACE, {
    title: 'Detail',
    parentId: parent.id,
  });
  await pages.update(SPACE, child.id, {
    expectedRevision: 1,
    title: 'New detail',
    content: 'Markdown **body**',
  });
  state.close();

  // Reopen the same durable state and prove the committed values survived.
  const reopened = openFeltState({ path: join(dir, 'state') });
  const after = new Pages(reopened.db, () => true);
  expect(await after.get(SPACE, child.id)).toMatchObject({
    title: 'New detail',
    content: 'Markdown **body**',
    revision: 2,
    parentId: parent.id,
  });
  expect((await after.list(SPACE)).map((p) => p.title).sort()).toEqual([
    'New detail',
    'Plan',
  ]);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

it('rejects cross-space parents, cycles and stale writes without losing content', async () => {
  const { pages, close } = durablePages();
  const a = SPACE,
    b = 'space-2';
  const root = await pages.create(a, { title: 'Root' });
  const child = await pages.create(a, {
    title: 'Child',
    parentId: root.id,
  });
  await expect(
    pages.create(b, { title: 'Wrong', parentId: root.id }),
  ).rejects.toThrow();
  await expect(
    pages.update(a, root.id, { expectedRevision: 1, parentId: child.id }),
  ).rejects.toThrow(/itself or a descendant/);
  await pages.update(a, root.id, { expectedRevision: 1, content: 'New' });
  await expect(
    pages.update(a, root.id, { expectedRevision: 1, content: 'Stale' }),
  ).rejects.toThrow(/changed/);
  expect((await pages.get(a, root.id)).content).toBe('New');
  await expect(pages.get(b, root.id)).rejects.toThrow(/not found/i);
  close();
});

describe('FeltDB-backed pages', () => {
  it('creates, reads and lists pages with stable ordering', async () => {
    const { pages, close } = durablePages();
    const space = SPACE,
      other = 'space-2';

    const first = await pages.create(space, { title: 'One' });
    await pages.create(space, { title: 'Two' });
    await pages.create(other, { title: 'Elsewhere' });

    expect(first).toMatchObject({
      spaceId: space,
      parentId: null,
      title: 'One',
      content: '',
      revision: 1,
      sourceThreadId: null,
    });
    expect((await pages.get(space, first.id)).title).toBe('One');
    expect((await pages.list(space)).map((p) => p.title)).toEqual([
      'One',
      'Two',
    ]);
    expect(await pages.list(other)).toHaveLength(1);
    // A page is not readable through another Space.
    await expect(pages.get(other, first.id)).rejects.toThrow(/not found/i);
    close();
  });

  it('rejects a missing page without leaking a storage error', async () => {
    const { pages, close } = durablePages();
    await expect(pages.get(SPACE, 'missing')).rejects.toThrow(
      /Page not found in this Space/,
    );
    await expect(
      pages.update(SPACE, 'missing', {
        expectedRevision: 1,
        content: 'x',
      }),
    ).rejects.toThrow(/Page not found in this Space/);
    close();
  });

  it('rejects an unknown Space with the existing error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dots-nospace-'));
    const state = openFeltState({ path: join(dir, 'state') });
    const pages = new Pages(state.db, () => false);
    await expect(pages.list('missing-space')).rejects.toThrow(
      /Space not found/,
    );
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('advances the revision by exactly one per accepted update', async () => {
    const { pages, close } = durablePages();
    const page = await pages.create(SPACE, { title: 'Draft' });

    const second = await pages.update(SPACE, page.id, {
      expectedRevision: 1,
      content: 'two',
    });
    expect(second.revision).toBe(2);
    const third = await pages.update(SPACE, page.id, {
      expectedRevision: 2,
      content: 'three',
    });
    expect(third.revision).toBe(3);
    expect(third.content).toBe('three');
    close();
  });

  it('rejects a stale revision with a conflict and leaves content intact', async () => {
    const { pages, close } = durablePages();
    const page = await pages.create(SPACE, { title: 'Draft' });
    await pages.update(SPACE, page.id, {
      expectedRevision: 1,
      content: 'winner',
    });

    await expect(
      pages.update(SPACE, page.id, {
        expectedRevision: 1,
        content: 'loser',
      }),
    ).rejects.toThrow(/This page changed/);

    const current = await pages.get(SPACE, page.id);
    expect(current.content).toBe('winner');
    expect(current.revision).toBe(2);
    close();
  });

  it('lets exactly one of two competing writers commit a revision', async () => {
    const { pages, close } = durablePages();
    const page = await pages.create(SPACE, { title: 'Contended' });

    const attempt = (content: string) =>
      pages.update(SPACE, page.id, { expectedRevision: 1, content }).then(
        () => 'won' as const,
        () => 'lost' as const,
      );

    const [a, b] = await Promise.all([attempt('A'), attempt('B')]);
    expect([a, b].sort()).toEqual(['lost', 'won']);

    const current = await pages.get(SPACE, page.id);
    expect(current.revision).toBe(2);
    expect(['A', 'B']).toContain(current.content);
    close();
  });

  it('holds to a single winner across many competing writers', async () => {
    const { pages, close } = durablePages();
    const page = await pages.create(SPACE, { title: 'Stampede' });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        pages
          .update(SPACE, page.id, {
            expectedRevision: 1,
            content: `#${index}`,
          })
          .then(
            () => 'won' as const,
            () => 'lost' as const,
          ),
      ),
    );
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect((await pages.get(SPACE, page.id)).revision).toBe(2);
    close();
  });

  it('does not expose the storage fence on the page representation', async () => {
    const { pages, state, close } = durablePages();
    const page = await pages.create(SPACE, { title: 'Clean' });
    expect(page).not.toHaveProperty('__version');
    const updated = await pages.update(SPACE, page.id, {
      expectedRevision: 1,
      content: 'x',
    });
    expect(updated).not.toHaveProperty('__version');
    // The durable record keeps its own fence, independent of `revision`.
    const stored = await state.db
      .collection<{ __version?: number; revision: number }>('pages')
      .get(page.id);
    expect(stored?.__version).toBe(2);
    expect(stored?.revision).toBe(2);
    close();
  });

  it('saves an approved review exactly once and replays it idempotently', async () => {
    const { pages, close } = durablePages();
    const space = SPACE;
    const first = await pages.createReviewed(
      space,
      { title: 'Reviewed', content: 'Draft' },
      'thread-1',
      'call-1',
    );
    expect(first).toMatchObject({ revision: 1, sourceThreadId: 'thread-1' });
    expect(await pages.reviewReceipt('thread-1', 'call-1')).toEqual({
      pageId: first.id,
      spaceId: space,
    });

    // A retry returns the same page rather than creating a second one.
    const again = await pages.createReviewed(
      space,
      { title: 'Reviewed', content: 'Draft' },
      'thread-1',
      'call-1',
    );
    expect(again.id).toBe(first.id);
    expect(await pages.list(space)).toHaveLength(1);

    // The same tool call cannot be saved into a different Space.
    await expect(
      pages.createReviewed(
        'space-2',
        { title: 'Reviewed', content: 'Draft' },
        'thread-1',
        'call-1',
      ),
    ).rejects.toThrow(/already saved to another Space/);
    close();
  });

  it('keeps review keys distinct for ids that concatenate ambiguously', async () => {
    const { pages, close } = durablePages();
    const a = await pages.createReviewed(
      SPACE,
      { title: 'A', content: 'x' },
      'ab',
      'c',
    );
    const b = await pages.createReviewed(
      SPACE,
      { title: 'B', content: 'x' },
      'a',
      'bc',
    );
    expect(a.id).not.toBe(b.id);
    expect((await pages.list(SPACE)).map((p) => p.title).sort()).toEqual([
      'A',
      'B',
    ]);
    close();
  });

  it('creates one page when the same review is approved concurrently', async () => {
    const { pages, close } = durablePages();
    const attempt = () =>
      pages
        .createReviewed(SPACE, { title: 'Race', content: 'x' }, 't', 'c')
        .then(
          (page) => ({ ok: true as const, id: page.id }),
          (error: unknown) => ({
            ok: false as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    const results = await Promise.all([attempt(), attempt()]);

    // Exactly one page is created, however many callers raced for it.
    const listed = await pages.list(SPACE);
    expect(listed).toHaveLength(1);
    // Both callers resolve to that same page: the loser is told about the
    // winner's page rather than failing work that actually succeeded.
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    for (const result of results) {
      expect(result.ok && result.id).toBe(listed[0].id);
    }
    close();
  });

  it('keeps pages and receipts durable across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dots-durable-'));
    const first = openFeltState({ path: join(dir, 'state') });
    const pages = new Pages(first.db, () => true);
    const page = await pages.create(SPACE, {
      title: 'Durable',
      content: 'body',
    });
    await pages.createReviewed(
      SPACE,
      { title: 'Approved', content: 'x' },
      't1',
      'c1',
    );
    first.close();

    const second = openFeltState({ path: join(dir, 'state') });
    const reopened = new Pages(second.db, () => true);
    expect(await reopened.get(SPACE, page.id)).toMatchObject({
      title: 'Durable',
      content: 'body',
      revision: 1,
    });
    expect(await reopened.list(SPACE)).toHaveLength(2);
    expect(await reopened.reviewReceipt('t1', 'c1')).toMatchObject({
      spaceId: SPACE,
    });
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
