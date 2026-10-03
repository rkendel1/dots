/**
 * Read-only access to the legacy SQLite database.
 *
 * This is the only file in the repository that imports `node:sqlite`, and it
 * lives outside `src` so the runtime server build cannot reach it. The database
 * is opened read-only and never written, marked, vacuumed or altered: it is
 * historical input for Phase 6 and nothing else.
 *
 * Every read is ordered explicitly so the import is deterministic. Where the
 * original schema used `rowid` as an ordering key (`computer_audit`) the rows
 * are returned in `rowid` order, which is what lets the importer reproduce the
 * legacy `createdAt DESC, rowid DESC` tiebreak by insertion order alone.
 */
import { DatabaseSync } from 'node:sqlite';

export interface LegacyPageRow {
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

export interface LegacyPageReviewRow {
  threadId: string;
  toolCallId: string;
  pageId: string;
  spaceId: string;
}

export interface LegacyTaskRow {
  id: string;
  prompt: string;
  status: string;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  lease: string | null;
  leaseUntil: number | null;
}

export interface LegacyRunRow {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  result: string | null;
  error: string | null;
}

export interface LegacyEventRow {
  /** Global AUTOINCREMENT. Only its order within a task is ever read. */
  id: number;
  taskId: string;
  runId: string | null;
  text: string;
  createdAt: number;
}

export interface LegacyMemoryRow {
  id: string;
  text: string;
  createdAt: number;
}

export interface LegacySpaceRow {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface LegacyDotRow {
  id: string;
  spaceId: string;
  name: string;
  instructions: string;
  researchAllowed: number;
  memoryAllowed: number;
  createdAt: number;
  learningContainerId: string | null;
  skillDeliveryEnabled: number;
}

export interface LegacyGrantRow {
  dotId: string;
  spaceId: string;
}

export interface LegacyThreadBindingRow {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  learningContainerId: string | null;
}

export interface LegacyPageThreadRow {
  pageId: string;
  dotId: string;
  threadId: string;
  ready: number;
  leaseUntil: number;
}

export interface LegacyTaskThreadRow {
  taskId: string;
  threadId: string;
}

export interface LegacyCallRow {
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  status: string;
  transcript: string;
  error: string | null;
  anchorMessageId?: string | null;
}

export interface LegacyCaptureRow {
  threadId: string;
  value: string;
}

export interface LegacyPermissionRow {
  dotId: string;
  value: string;
}

export interface LegacyAuditRow {
  id: string;
  dotId: string;
  action: string;
  actor: string;
  outcome: string;
  createdAt: number;
}

/** Everything the importer reads, captured once so the source is a snapshot. */
export interface LegacySnapshot {
  settings: { value: string } | undefined;
  spaces: LegacySpaceRow[];
  dots: LegacyDotRow[];
  grants: LegacyGrantRow[];
  pages: LegacyPageRow[];
  pageReviews: LegacyPageReviewRow[];
  threadBindings: LegacyThreadBindingRow[];
  pageThreads: LegacyPageThreadRow[];
  tasks: LegacyTaskRow[];
  taskThreads: LegacyTaskThreadRow[];
  runs: LegacyRunRow[];
  events: LegacyEventRow[];
  memories: LegacyMemoryRow[];
  calls: LegacyCallRow[];
  captures: LegacyCaptureRow[];
  permissions: LegacyPermissionRow[];
  audit: LegacyAuditRow[];
}

function rows<T>(db: DatabaseSync, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

/**
 * Read the whole legacy database into memory.
 *
 * The dataset is one personal workspace — kilobytes, not gigabytes — so a single
 * read is both simplest and safest: the importer sees one consistent snapshot
 * and never half-applies a state that was mid-write.
 */
export function readLegacy(path: string): LegacySnapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      settings: db.prepare('SELECT value FROM settings WHERE id = 1').get() as
        { value: string } | undefined,
      spaces: rows(
        db,
        'SELECT id, name, description, createdAt FROM spaces ORDER BY createdAt, id',
      ),
      dots: rows(
        db,
        `SELECT id, spaceId, name, instructions, researchAllowed, memoryAllowed,
                createdAt, learningContainerId, skillDeliveryEnabled
           FROM dots ORDER BY createdAt, id`,
      ),
      grants: rows(
        db,
        'SELECT dotId, spaceId FROM dot_spaces ORDER BY dotId, spaceId',
      ),
      pages: rows(
        db,
        `SELECT id, spaceId, parentId, title, content, revision, createdAt,
                updatedAt, sourceThreadId
           FROM pages ORDER BY createdAt, id`,
      ),
      pageReviews: rows(
        db,
        `SELECT threadId, toolCallId, pageId, spaceId
           FROM page_reviews ORDER BY threadId, toolCallId`,
      ),
      threadBindings: rows(
        db,
        `SELECT id, dotId, ownerId, title, createdAt, learningContainerId
           FROM thread_bindings ORDER BY createdAt, id`,
      ),
      // `rowid` order, so the marker synthesis and any future trim reproduce the
      // legacy ordering exactly.
      pageThreads: rows(
        db,
        `SELECT pageId, dotId, threadId, ready, leaseUntil
           FROM page_threads ORDER BY rowid`,
      ),
      tasks: rows(
        db,
        `SELECT id, prompt, status, intervalSeconds, nextRunAt, createdAt,
                updatedAt, error, lease, leaseUntil
           FROM tasks ORDER BY createdAt, id`,
      ),
      taskThreads: rows(
        db,
        'SELECT taskId, threadId FROM task_threads ORDER BY taskId',
      ),
      // Runs are read newest-first per task by `reverse()`ing the whole
      // collection, so `rowid` order is what reproduces the legacy
      // `ORDER BY startedAt DESC, rowid DESC` tiebreak.
      runs: rows(
        db,
        `SELECT id, taskId, status, startedAt, finishedAt, result, error
           FROM runs ORDER BY rowid`,
      ),
      events: rows(
        db,
        `SELECT id, taskId, runId, text, createdAt FROM events ORDER BY id`,
      ),
      memories: rows(
        db,
        'SELECT id, text, createdAt FROM memories ORDER BY createdAt, id',
      ),
      // Same reasoning as `runs`: the runtime reverses the collection before
      // sorting by `startedAt`, so insertion order must be `rowid` order.
      calls: rows(
        db,
        `SELECT id, threadId, startedAt, endedAt, status, transcript, error,
                anchorMessageId
           FROM calls ORDER BY rowid`,
      ),
      captures: rows(
        db,
        'SELECT threadId, value FROM captures ORDER BY threadId',
      ),
      permissions: rows(
        db,
        'SELECT dotId, value FROM computer_permissions ORDER BY dotId',
      ),
      audit: rows(
        db,
        `SELECT id, dotId, action, actor, outcome, createdAt
           FROM computer_audit ORDER BY rowid`,
      ),
    };
  } finally {
    // Closing releases the read handle; the file itself is never modified.
    db.close();
  }
}
