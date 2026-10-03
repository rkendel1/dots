import { createHash } from 'node:crypto';
import type { Collection, StateFirstDB } from '@feltdb/core';
import type { CallReceipt, Dot, Space } from '../shared/types.js';
import {
  isLostRace,
  transactionId,
  withoutStorageFields,
  type StorageFence,
} from './felt/records.js';

export { isLostRace, transactionId };

/**
 * FeltDB storage for the state `WorkspaceStore` owns.
 *
 * Workspace metadata plus the conversation-side records that used to sit in
 * SQLite: Spaces, Dots, their Space grants, thread bindings, page-thread
 * reservations, task-thread bindings, voice calls and page captures. Page rows
 * are owned by `Pages`, and the task/lease/event/memory domains by `Store`.
 */

/** The durable Space record. Field names match the SQLite columns exactly. */
export interface SpaceRecord extends Space {
  /** FeltDB's per-record fence. Storage bookkeeping only, never a domain field. */
  __version?: number;
}

/**
 * The durable Dot record.
 *
 * `spaceIds` is deliberately absent: membership is derived from
 * `dot_space_grants`, so there is exactly one authoritative representation of
 * the Dot/Space relationship.
 */
export interface DotRecord {
  id: string;
  /** Default destination for saved pages, not ownership. */
  spaceId: string;
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  createdAt: number;
  learningContainerId: string | null;
  skillDeliveryEnabled: boolean;
  /** FeltDB's per-record fence. Storage bookkeeping only, never a domain field. */
  __version?: number;
}

/** One Dot/Space grant. The pair lives in the value; the key is a digest. */
export interface GrantRecord {
  dotId: string;
  spaceId: string;
}

/**
 * The application-side binding for an externally owned conversation thread.
 *
 * Conversation *messages* stay authoritative in CopilotKit Intelligence; this
 * records only OpenDots' binding and metadata.
 */
export interface ThreadBindingRecord {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  /** Frozen at creation; null means this conversation does not participate. */
  learningContainerId: string | null;
}

/**
 * One page-to-conversation reservation.
 *
 * The SQLite primary key was the composite `(pageId, dotId)`; `threadId` carried
 * a second, global UNIQUE constraint. `ready` was an integer there and is a real
 * boolean here.
 */
export interface PageThreadRecord extends StorageFence {
  pageId: string;
  dotId: string;
  threadId: string;
  ready: boolean;
  leaseUntil: number;
}

/**
 * A create-only marker proving a conversation is anchored in at most one page.
 *
 * This is the durable half of the SQLite `UNIQUE(threadId)` constraint: the
 * reservation and this marker are written in one transaction, so a thread can
 * never anchor two pages.
 */
export interface PageThreadIdRecord {
  threadId: string;
}

/** The conversation a scheduled task runs in. */
export interface TaskThreadRecord extends StorageFence {
  taskId: string;
  threadId: string;
}

/** One voice call. `anchorMessageId` arrived via SQLite `ALTER TABLE`. */
export interface CallRecord extends CallReceipt, StorageFence {}

/** The last page capture for a conversation. */
export interface CaptureRecord extends StorageFence {
  threadId: string;
  value: unknown;
}

/**
 * Deterministic key for an ordered pair of ids.
 *
 * FeltDB accepts only `[A-Za-z0-9._-]` in a transaction or operation id, while
 * Dot and Space ids are UUIDs that may be joined by any separator. Each part is
 * length-prefixed before hashing, so no two distinct pairs can produce the same
 * pre-image: the encoding is unambiguous without relying on a delimiter that a
 * value could itself contain.
 */
export function pairKey(...parts: string[]) {
  return createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join(''))
    .digest('hex');
}

/** The grant key for one (dotId, spaceId) pair. */
export function grantKey(dotId: string, spaceId: string) {
  return pairKey('dot-space-grant', dotId, spaceId);
}

export interface WorkspaceCollections {
  spaces: Collection<SpaceRecord>;
  dots: Collection<DotRecord>;
  dotSpaceGrants: Collection<GrantRecord>;
  threadBindings: Collection<ThreadBindingRecord>;
  pageThreads: Collection<PageThreadRecord>;
  pageThreadIds: Collection<PageThreadIdRecord>;
  taskThreads: Collection<TaskThreadRecord>;
  calls: Collection<CallRecord>;
  captures: Collection<CaptureRecord>;
}

export function workspaceCollections(db: StateFirstDB): WorkspaceCollections {
  return {
    spaces: db.collection<SpaceRecord>('spaces'),
    dots: db.collection<DotRecord>('dots'),
    dotSpaceGrants: db.collection<GrantRecord>('dot_space_grants'),
    threadBindings: db.collection<ThreadBindingRecord>('thread_bindings'),
    pageThreads: db.collection<PageThreadRecord>('page_threads'),
    pageThreadIds: db.collection<PageThreadIdRecord>('page_thread_ids'),
    taskThreads: db.collection<TaskThreadRecord>('task_threads'),
    calls: db.collection<CallRecord>('calls'),
    captures: db.collection<CaptureRecord>('captures'),
  };
}

/**
 * Key for one page-to-conversation reservation.
 *
 * The SQLite primary key was composite `(pageId, dotId)`. Both parts are UUIDs
 * and `.` is one of the characters FeltDB accepts in a record key, so the join
 * is unambiguous and readable rather than hashed.
 */
export function pageThreadKey(pageId: string, dotId: string) {
  return `${pageId}.${dotId}`;
}

/** Strip the storage fence before a record crosses the application boundary. */
export function toSpace(record: SpaceRecord): Space {
  return withoutStorageFields(record);
}

/** Strip the storage fence and derive membership from the grants. */
export function toDot(record: DotRecord, grants: GrantRecord[]): Dot {
  const dot = withoutStorageFields(record);
  // Sorted to match the previous `ORDER BY spaceId` read of dot_spaces.
  const spaceIds = grants
    .filter((grant) => grant.dotId === record.id)
    .map((grant) => grant.spaceId)
    .sort();
  return { ...dot, spaceIds };
}
