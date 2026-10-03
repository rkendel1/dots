import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import {
  isLostRace,
  transactionId,
  withoutStorageFields,
} from './felt/records.js';
import {
  pageThreadKey,
  type PageThreadIdRecord,
  type PageThreadRecord,
} from './workspace-collections.js';
import type { PageThreadSource } from './pages.js';

/** How long a conversation-creation lease is held. */
const LEASE_MS = 60_000;

/** Bounded retries for a lost conditional write. */
const MAX_ATTEMPTS = 8;

/** What `PageThreads` reports back, exactly as the SQLite version did. */
export interface PageThread {
  threadId: string;
  ready: boolean;
}

/**
 * Page-to-conversation reservations.
 *
 * The SQLite table had a composite `(pageId, dotId)` primary key plus a separate
 * global `UNIQUE(threadId)`. FeltDB has one key per record, so the reservation
 * is keyed by the pair and a create-only `page_thread_ids` marker carries the
 * thread constraint. The two are written together, which is what preserves
 * "one conversation anchors in at most one page".
 *
 * The lease is the only mutual exclusion in this domain. SQLite serialised it
 * implicitly; here it is an explicit conditional write fenced on the version
 * that was read, so concurrent callers still produce exactly one winner.
 */
export class PageThreads implements PageThreadSource {
  constructor(
    private readonly state: StateFirstDB,
    private readonly reservations: ReservationCollection,
    private readonly threadIds: ThreadIdCollection,
  ) {}

  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }

  async thread(pageId: string, dotId: string): Promise<PageThread | undefined> {
    const record = await this.reservations.get(pageThreadKey(pageId, dotId));
    return record
      ? { threadId: record.threadId, ready: record.ready }
      : undefined;
  }

  /**
   * Reserve a conversation for a page, taking the creation lease.
   *
   * Returns `true` only when this caller both found the row unleased and not yet
   * ready. A ready row, a row with a live lease, or a thread already anchored
   * elsewhere all return `false`, and `page-service` turns that into a 409.
   */
  async reserveThread(
    pageId: string,
    dotId: string,
    threadId: string,
  ): Promise<boolean> {
    if (!(await this.create(pageId, dotId, threadId))) return false;
    return this.takeLease(pageId, dotId);
  }

  /**
   * `INSERT OR IGNORE` — create-only on the pair, honouring the thread
   * constraint.
   *
   * Returns whether a row now exists for the pair. When the offered thread is
   * already anchored elsewhere, SQLite's UNIQUE conflict meant nothing was
   * written at all, so this reports `false` and the caller never sees a row.
   */
  private async create(
    pageId: string,
    dotId: string,
    threadId: string,
  ): Promise<boolean> {
    const key = pageThreadKey(pageId, dotId);
    if (await this.reservations.get(key)) return true;
    try {
      await this.commit('page-thread-create', (tx) => {
        tx.collection<PageThreadRecord>('page_threads').set(
          key,
          {
            pageId,
            dotId,
            threadId,
            ready: false,
            leaseUntil: 0,
            __version: 1,
          },
          { requireAbsent: true },
        );
        // The durable half of the old UNIQUE(threadId) constraint.
        tx.collection<PageThreadIdRecord>('page_thread_ids').set(
          threadId,
          { threadId },
          { requireAbsent: true },
        );
      });
      return true;
    } catch (error) {
      if (!isLostRace(error)) throw error;
      // Refused: either another caller created the pair first — the
      // `INSERT OR IGNORE` case, where their threadId stands — or this thread is
      // already anchored somewhere and nothing may be written.
      return (await this.reservations.get(key)) !== null;
    }
  }
  /**
   * The conditional lease write, fenced on the version that was read.
   *
   * This is the domain rule SQLite evaluated inside its write lock:
   * `WHERE pageId=? AND dotId=? AND ready=0 AND leaseUntil<=?`.
   */
  private async takeLease(pageId: string, dotId: string): Promise<boolean> {
    const key = pageThreadKey(pageId, dotId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.reservations.get(key);
      if (!record) return false;
      const now = Date.now();
      if (record.ready || record.leaseUntil > now) return false;
      try {
        await this.commit('page-thread-lease', (tx) => {
          tx.collection<PageThreadRecord>('page_threads').set(
            key,
            {
              ...withoutStorageFields(record),
              leaseUntil: now + LEASE_MS,
              __version: (record.__version ?? 1) + 1,
            },
            { expectedVersion: record.__version ?? 1 },
          );
        });
        return true;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
    return false;
  }

  async finishThread(pageId: string, dotId: string): Promise<void> {
    await this.patch(pageId, dotId, { ready: true });
  }

  async releaseThread(pageId: string, dotId: string): Promise<void> {
    await this.patch(
      pageId,
      dotId,
      { leaseUntil: 0 },
      (record) => !record.ready,
    );
  }

  /**
   * Apply a conditional update to one reservation.
   *
   * `guard` reproduces a `WHERE` clause SQLite evaluated on the row; a record
   * that fails it is left untouched, exactly as before.
   */
  private async patch(
    pageId: string,
    dotId: string,
    changes: Partial<PageThreadRecord>,
    guard?: (record: PageThreadRecord) => boolean,
  ): Promise<void> {
    const key = pageThreadKey(pageId, dotId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.reservations.get(key);
      // SQLite's UPDATE on an absent row was a silent no-op.
      if (!record) return;
      if (guard && !guard(record)) return;
      try {
        await this.commit('page-thread-patch', (tx) => {
          tx.collection<PageThreadRecord>('page_threads').set(
            key,
            {
              ...withoutStorageFields(record),
              ...changes,
              __version: (record.__version ?? 1) + 1,
            },
            { expectedVersion: record.__version ?? 1 },
          );
        });
        return;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
  }

  /**
   * The page a ready thread is anchored in, if any.
   *
   * SQLite answered this from the unique index on `threadId`. FeltDB's key is
   * the page/Dot pair, so this filters the (small) reservation set by thread —
   * the same trade Phase 3 made for dot-space grants.
   */
  async pageIdForThread(threadId: string): Promise<string | undefined> {
    for (const candidate of await this.reservations.all())
      if (candidate.threadId === threadId && candidate.ready)
        return candidate.pageId;
    return undefined;
  }
}

// Structural views keep the constructor honest without importing the whole
// collection module here.
interface ReservationCollection {
  get(id: string): Promise<PageThreadRecord | null>;
  all(): Promise<PageThreadRecord[]>;
}

interface ThreadIdCollection {
  get(id: string): Promise<PageThreadIdRecord | null>;
}
