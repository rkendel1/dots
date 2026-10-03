import { createHash, randomUUID } from 'node:crypto';
import type { Collection, StateFirstDB } from '@feltdb/core';
import { z } from 'zod';
export const pageInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    content: z.string().max(100000).default(''),
    parentId: z.string().min(1).nullable().default(null),
  })
  .strict();
export const pagePatch = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    content: z.string().max(100000).optional(),
    parentId: z.string().min(1).nullable().optional(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceThreadId: string | null;
}
export class PageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}
/**
 * The durable page record.
 *
 * `revision` is the product-level optimistic-concurrency token exposed to
 * clients and agents. `__version` is FeltDB's own per-record fence and is
 * storage bookkeeping only: it is never read as, or written as, the page
 * revision. Every write passes it back through `updateIfVersion`, so only one
 * competing writer can commit a given revision transition.
 */
interface PageRecord {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceThreadId: string | null;
  /** FeltDB's per-record fence. Storage bookkeeping only. */
  __version?: number;
  /** Lets a page record be staged into a transaction operation. */
  [key: string]: unknown;
}

interface PageReviewRecord {
  pageId: string;
  spaceId: string;
}

const conflict = () =>
  new PageError(
    'This page changed. Reload the latest revision before saving your draft.',
    409,
  );

/**
 * Review key for a (threadId, toolCallId) pair, mirroring the SQLite primary
 * key.
 *
 * A unit separator joins the parts: FeltDB rejects whitespace inside a
 * transaction operation id, and a control character cannot appear in a thread
 * or tool-call id, so the key is unambiguous without hashing.
 */
/**
 * Review key for a (threadId, toolCallId) pair, mirroring the SQLite primary
 * key.
 *
 * FeltDB only accepts `[A-Za-z0-9._-]` in a transaction id, and a thread or
 * tool-call id may contain anything, so the pair is hashed. The components are
 * length-prefixed first so no two distinct pairs can collide by concatenation,
 * and the digest keeps the key stable across restarts.
 */
export function reviewKey(threadId: string, toolCallId: string) {
  return createHash('sha256')
    .update(`${threadId.length}:${threadId}${toolCallId.length}:${toolCallId}`)
    .digest('hex');
}

/** Strip the storage-only fence before a page crosses the application boundary. */
function toPage(record: PageRecord): Page {
  const page = { ...record };
  // The fence is storage bookkeeping and never crosses the app boundary.
  delete page.__version;
  return page;
}

/**
 * The page-to-thread reservations Pages forwards to.
 *
 * Durable in FeltDB, but the interface is unchanged from when they lived in
 * SQLite: `PageThreads` keeps the same five methods, now async.
 */
export interface PageThreadSource {
  thread(
    pageId: string,
    dotId: string,
  ): Promise<{ threadId: string; ready: boolean } | undefined>;
  reserveThread(
    pageId: string,
    dotId: string,
    threadId: string,
  ): Promise<boolean>;
  finishThread(pageId: string, dotId: string): Promise<void>;
  releaseThread(pageId: string, dotId: string): Promise<void>;
  pageIdForThread(threadId: string): Promise<string | undefined>;
}

/**
 * Durable owner for pages and page reviews.
 *
 * The `state.db` handle is owned by the application; this store never opens or
 * closes it. Page-thread reservations are durable too, and reach this store
 * through the attached `PageThreadSource`.
 */
export class Pages {
  private readonly pages: Collection<PageRecord>;
  private readonly reviews: Collection<PageReviewRecord>;
  constructor(
    private readonly state: StateFirstDB,
    private readonly spaceExists: (id: string) => boolean | Promise<boolean>,
  ) {
    this.pages = state.collection<PageRecord>('pages');
    this.reviews = state.collection<PageReviewRecord>('page_reviews');
  }
  /**
   * Page-to-thread reservations, owned by `PageThreads` and durable in the same
   * state. This store forwards to them so callers keep one entry point.
   */
  private threadSource?: PageThreadSource;
  attachPageThreads(threads: PageThreadSource) {
    this.threadSource = threads;
  }
  thread(pageId: string, dotId: string) {
    return this.threads().thread(pageId, dotId);
  }
  reserveThread(pageId: string, dotId: string, threadId: string) {
    return this.threads().reserveThread(pageId, dotId, threadId);
  }
  finishThread(pageId: string, dotId: string) {
    this.threads().finishThread(pageId, dotId);
  }
  releaseThread(pageId: string, dotId: string) {
    this.threads().releaseThread(pageId, dotId);
  }
  private threads() {
    if (!this.threadSource)
      throw new Error('Page threads are not attached to this store.');
    return this.threadSource;
  }
  /**
   * The page a ready conversation is anchored in.
   *
   * The Space is resolved from the page itself, or from the Space the caller
   * scoped the lookup to, matching the previous SQL join.
   */
  async forThread(
    threadId: string,
    spaceId?: string,
  ): Promise<Page | undefined> {
    const pageId = await this.threads().pageIdForThread(threadId);
    if (!pageId) return undefined;
    const row = await this.pages.get(pageId);
    if (!row) return undefined;
    if (spaceId !== undefined && row.spaceId !== spaceId) return undefined;
    return toPage(row);
  }
  async requireSpace(spaceId: string) {
    if (!(await this.spaceExists(spaceId)))
      throw new PageError('Space not found.', 404);
  }
  async list(spaceId: string): Promise<Page[]> {
    await this.requireSpace(spaceId);
    const found = await this.pages.find(
      { spaceId },
      { orderBy: [{ field: 'createdAt', direction: 'asc' }] },
    );
    // SQLite ordered by `createdAt, id`; the id tiebreak keeps that stable.
    return found
      .map(toPage)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async get(spaceId: string, id: string): Promise<Page> {
    await this.requireSpace(spaceId);
    const row = await this.pages.get(id);
    if (!row || row.spaceId !== spaceId)
      throw new PageError('Page not found in this Space.', 404);
    return toPage(row);
  }
  /**
   * Walk the parent chain, rejecting a cycle.
   *
   * `id` is the page being moved, so moving a page under itself or under one of
   * its descendants throws instead of creating an unreachable tree.
   */
  private async parent(spaceId: string, parentId: string | null, id?: string) {
    const seen = new Set(id ? [id] : []);
    let cursor = parentId;
    while (cursor) {
      if (seen.has(cursor))
        throw new PageError(
          'A page cannot be moved into itself or a descendant.',
        );
      seen.add(cursor);
      cursor = (await this.get(spaceId, cursor)).parentId;
    }
  }
  async create(
    spaceId: string,
    input: z.input<typeof pageInput>,
    sourceThreadId: string | null = null,
  ): Promise<Page> {
    await this.requireSpace(spaceId);
    const parsed = pageInput.safeParse(input);
    if (!parsed.success)
      throw new PageError(
        'Pages require a title up to 160 characters and content up to 100,000 characters.',
      );
    const data = parsed.data;
    await this.parent(spaceId, data.parentId);
    const id = randomUUID(),
      now = Date.now();
    const record: PageRecord = {
      id,
      spaceId,
      parentId: data.parentId,
      title: data.title,
      content: data.content,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      sourceThreadId,
    };
    // Ids are fresh UUIDs, but FeltDB's insert is an upsert (Phase 0, F3), so
    // create-only is asserted rather than assumed.
    const created = await this.pages.putIfAbsent(id, record);
    if (!created.inserted)
      throw new PageError('Page could not be created.', 400);
    return toPage(created.value);
  }
  async reviewReceipt(
    threadId: string,
    toolCallId: string,
  ): Promise<{ pageId: string; spaceId: string } | null> {
    const row = await this.reviews.get(reviewKey(threadId, toolCallId));
    return row ? { pageId: row.pageId, spaceId: row.spaceId } : null;
  }
  /**
   * Create the page for an approved review exactly once.
   *
   * The receipt and the page are written in one transaction guarded by
   * `requireAbsent`, so concurrent approvals of the same tool call produce one
   * page and one loser, never two. The transaction id is derived from the tool
   * call, so a retry after a lost response replays instead of duplicating.
   */
  async createReviewed(
    spaceId: string,
    input: z.input<typeof pageInput>,
    threadId: string,
    toolCallId: string,
  ): Promise<Page> {
    const parsed = pageInput.safeParse(input);
    if (!parsed.success)
      throw new PageError(
        'Pages require a title up to 160 characters and content up to 100,000 characters.',
      );
    const data = parsed.data;
    const key = reviewKey(threadId, toolCallId);

    // An existing receipt short-circuits before any write, exactly as the
    // previous read-then-branch implementation did.
    const previous = await this.reviewReceipt(threadId, toolCallId);
    if (previous) {
      if (previous.spaceId !== spaceId)
        throw new PageError(
          'This review was already saved to another Space.',
          409,
        );
      return this.get(spaceId, previous.pageId);
    }

    await this.requireSpace(spaceId);
    await this.parent(spaceId, data.parentId);
    const pageId = randomUUID(),
      now = Date.now();
    const page: PageRecord = {
      id: pageId,
      spaceId,
      parentId: data.parentId,
      title: data.title,
      content: data.content,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      sourceThreadId: threadId,
    };
    try {
      await this.state.transaction({
        // Derived from the tool call so a retry replays instead of duplicating.
        transactionId: `page-review-${reviewKey(threadId, toolCallId)}`,
        preconditions: [
          { collection: 'page_reviews', id: key, requireAbsent: true },
          { collection: 'pages', id: pageId, requireAbsent: true },
        ],
        operations: [
          { collection: 'page_reviews', id: key, value: { pageId, spaceId } },
          // A staged write assigns no fence of its own (Phase 0, F2), so the
          // first update re-asserts one explicitly.
          { collection: 'pages', id: pageId, value: page },
        ],
      });
    } catch (error) {
      // Another approval of the same tool call won the race: return its page.
      if ((error as { code?: string }).code === 'PRECONDITION_FAILED') {
        const settled = await this.reviewReceipt(threadId, toolCallId);
        if (settled) {
          if (settled.spaceId !== spaceId)
            throw new PageError(
              'This review was already saved to another Space.',
              409,
            );
          return this.get(spaceId, settled.pageId);
        }
      }
      throw error;
    }
    // A page staged inside a transaction carries no fence and is not reflected in
    // the collection cache until it refreshes, so read it back through the
    // transaction's own view rather than trusting a possibly stale get().
    const stored = await this.pages.get(pageId);
    if (!stored) {
      // Another writer may have committed this receipt first; report its page.
      const settled = await this.reviewReceipt(threadId, toolCallId);
      if (settled) {
        if (settled.spaceId !== spaceId)
          throw new PageError(
            'This review was already saved to another Space.',
            409,
          );
        return this.get(spaceId, settled.pageId);
      }
      throw new PageError('Page could not be created.', 400);
    }
    return toPage(stored);
  }
  /**
   * Apply a patch, advancing `revision` exactly once.
   *
   * The read validates the caller's `expectedRevision` and the parent chain;
   * `updateIfVersion` then makes the write atomic, so two writers that both
   * read revision N cannot both commit. The loser is rejected with the same
   * 409 the previous implementation returned.
   */
  async update(
    spaceId: string,
    id: string,
    input: z.input<typeof pagePatch>,
  ): Promise<Page> {
    const parsed = pagePatch.safeParse(input);
    if (!parsed.success)
      throw new PageError(
        'A valid page patch and expectedRevision are required.',
      );
    const data = parsed.data;
    // Read the durable record directly: the revision check is the product
    // contract, while the fence on this read is what makes the write atomic.
    const record = await this.pages.get(id);
    if (!record || record.spaceId !== spaceId)
      throw new PageError('Page not found in this Space.', 404);
    const page = toPage(record);
    if (page.revision !== data.expectedRevision) throw conflict();
    const parent = data.parentId === undefined ? page.parentId : data.parentId;
    await this.parent(spaceId, parent, id);
    const next = {
      title: data.title ?? page.title,
      content: data.content ?? page.content,
      parentId: parent,
      revision: page.revision + 1,
      updatedAt: Date.now(),
    };
    const result = await this.pages.updateIfVersion(
      id,
      record.__version ?? 1,
      next,
    );
    if (!result.updated) throw conflict();
    return toPage(result.item ?? { ...record, ...next });
  }
}
