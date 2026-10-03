import { ComputerStore } from './computer-store.js';
import { PageThreads } from './page-threads.js';
import { Pages } from './pages.js';
import { computerCollections } from './computer-collections.js';
import {
  byStartedAtDescRowidDesc,
  isLostRace,
  transactionId,
  withoutStorageFields,
} from './felt/records.js';
import {
  grantKey,
  toDot,
  toSpace,
  workspaceCollections,
  type CallRecord,
  type CaptureRecord,
  type DotRecord,
  type GrantRecord,
  type SpaceRecord,
  type ThreadBindingRecord,
  type WorkspaceCollections,
} from './workspace-collections.js';
import { randomUUID } from 'node:crypto';
import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import { validateLearningSettings } from '../shared/learning.js';
import type { CallReceipt, Conversation, Dot, Space } from '../shared/types.js';

/** Bounded retries for a lost conditional write. */
const MAX_ATTEMPTS = 8;

export class WorkspaceStore {
  /** The process-owned durable state that backs every domain here. */
  readonly state: StateFirstDB;
  private readonly felt: WorkspaceCollections;
  readonly pages: Pages;
  /**
   * Page-to-thread reservations. Durable in FeltDB now, but they stay attached
   * here because they join against page rows to resolve the Space a
   * conversation is anchored in.
   */
  readonly pageThreads: PageThreads;
  readonly computers: ComputerStore;
  constructor(
    readonly ownerId: string,
    /** The process-owned durable state that backs every domain here. */
    state: StateFirstDB,
  ) {
    this.state = state;
    this.felt = workspaceCollections(state);
    this.computers = new ComputerStore(state, computerCollections(state));
    this.pageThreads = new PageThreads(
      state,
      this.felt.pageThreads,
      this.felt.pageThreadIds,
    );
    this.pages = new Pages(state, (id) =>
      this.spaces().then((spaces) => spaces.some((space) => space.id === id)),
    );
    this.pages.attachPageThreads(this.pageThreads);
  }

  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }
  /**
   * Create the first-run default Space and Dot.
   *
   * This is a separate awaitable step rather than constructor work because the
   * durable state is promise-based. It keeps the previous semantics exactly: the
   * defaults are created only when no Space exists at all, so restarting never
   * duplicates them or resurrects a revoked grant.
   */
  async bootstrap() {
    if ((await this.spaces()).length) return;
    const space = await this.createSpace(
      'Everyday',
      'A little space for your day.',
    );
    await this.createDot(
      space.id,
      'Dot',
      'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
      true,
      true,
    );
  }
  async spaces(): Promise<Space[]> {
    // Sorted explicitly: `all()` returns insertion order, and the previous
    // implementation guaranteed `ORDER BY createdAt`.
    return (await this.felt.spaces.all())
      .map(toSpace)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async createSpace(name: string, description: string): Promise<Space> {
    const space: SpaceRecord = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    // SQLite's INSERT was create-only. FeltDB's insert() is an upsert (Phase 0,
    // F3), so create-only is asserted rather than assumed.
    const created = await this.felt.spaces.putIfAbsent(space.id, space);
    if (!created.inserted) throw new Error('Space already exists.');
    return toSpace(created.value);
  }
  private async grants(): Promise<GrantRecord[]> {
    return this.felt.dotSpaceGrants.all();
  }
  async dots(): Promise<Dot[]> {
    const [records, grants] = await Promise.all([
      this.felt.dots.all(),
      this.grants(),
    ]);
    return records.map((record) => toDot(record, grants));
  }
  async dot(id: string): Promise<Dot | null> {
    const [record, grants] = await Promise.all([
      this.felt.dots.get(id),
      this.grants(),
    ]);
    return record ? toDot(record, grants) : null;
  }
  async createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
  ): Promise<Dot> {
    await this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: DotRecord = {
      id: randomUUID(),
      spaceId,
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      learningContainerId,
      skillDeliveryEnabled,
      createdAt: Date.now(),
    };
    const grants = [...new Set(spaceIds)].sort();
    // The Dot and every grant land together. SQLite wrapped the same two writes
    // in a transaction, so a failure must not leave a Dot without its default
    // Space. Each id is fresh per attempt: reusing one would make a concurrent
    // call report `duplicate: true` and apply nothing.
    await this.state.transaction({
      transactionId: transactionId('create-dot'),
      operations: [
        { collection: 'dots', id: dot.id, value: { ...dot, __version: 1 } },
        ...grants.map((space) => ({
          collection: 'dot_space_grants',
          id: grantKey(dot.id, space),
          value: { dotId: dot.id, spaceId: space },
        })),
      ],
    });
    return { ...dot, spaceIds: grants };
  }
  async canAccessSpace(dotId: string, spaceId: string) {
    // Membership is derived from the grants alone, so this is the single
    // authoritative answer rather than a second copy of the relationship.
    return (await this.grants()).some(
      (grant) => grant.dotId === dotId && grant.spaceId === spaceId,
    );
  }
  private async validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    const spaces = await this.spaces();
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !spaces.some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  async updateDot(
    id: string,
    patch: Pick<
      Dot,
      'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
    },
  ): Promise<Dot> {
    const current = await this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    await this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const wanted = [...new Set(spaceIds)];
    const [record, allGrants] = await Promise.all([
      this.felt.dots.get(id),
      this.grants(),
    ]);
    if (!record) throw new Error('Dot not found.');
    const existing = allGrants.filter((grant) => grant.dotId === id);
    const kept = new Set(
      existing
        .filter((grant) => wanted.includes(grant.spaceId))
        .map((grant) => grant.spaceId),
    );
    // A staged write carries no fence of its own (Phase 0, F2), so the Dot's
    // fence is advanced explicitly here rather than silently reset. This is the
    // same transaction the SQLite version used: field updates and a full grant
    // replacement either both apply or neither does.
    await this.state.transaction({
      transactionId: transactionId('update-dot'),
      operations: [
        {
          collection: 'dots',
          id,
          value: {
            id,
            spaceId: defaultSpace,
            name: patch.name,
            instructions: patch.instructions,
            researchAllowed: patch.researchAllowed,
            memoryAllowed: patch.memoryAllowed,
            learningContainerId,
            skillDeliveryEnabled,
            createdAt: current.createdAt,
            __version: (record.__version ?? 1) + 1,
          },
        },
        // An operation with no `value` is a delete, which is how a revoked grant
        // is actually removed from the authoritative relationship.
        ...existing
          .filter((grant) => !wanted.includes(grant.spaceId))
          .map((grant) => ({
            collection: 'dot_space_grants',
            id: grantKey(id, grant.spaceId),
          })),
        ...wanted
          .filter((spaceId) => !kept.has(spaceId))
          .map((spaceId) => ({
            collection: 'dot_space_grants',
            id: grantKey(id, spaceId),
            value: { dotId: id, spaceId },
          })),
      ],
    });
    const updated = await this.dot(id);
    if (!updated) throw new Error('Dot not found.');
    return updated;
  }
  async conversations(): Promise<Conversation[]> {
    const bindings = await this.felt.threadBindings.all();
    return (
      bindings
        .filter((binding) => binding.ownerId === this.ownerId)
        // Matches the previous `ORDER BY createdAt DESC`.
        .sort((a, b) => b.createdAt - a.createdAt)
    );
  }
  async bindThread(
    id: string,
    dotId: string,
    title: string,
  ): Promise<Conversation> {
    const dot = await this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: ThreadBindingRecord = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
    };
    // SQLite's primary key rejected a duplicate id, so create-only is asserted
    // explicitly: an upsert would silently rebind a thread to another Dot.
    const created = await this.felt.threadBindings.putIfAbsent(id, value);
    if (!created.inserted) throw new Error('Conversation already exists.');
    return created.value;
  }
  async requireThread(id: string, dotId?: string): Promise<Conversation> {
    // Scoped to this owner exactly as the previous owner-filtered read was, so a
    // binding belonging to someone else stays invisible rather than becoming a
    // cross-owner lookup.
    const thread = (await this.conversations()).find(
      (candidate) => candidate.id === id,
    );
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  /**
   * Bind a scheduled task to the conversation it runs in.
   *
   * Create-only, as the bare SQLite `INSERT` was: a task may hold only one
   * conversation, and a second bind is refused. SQLite surfaced that as a raw
   * UNIQUE-constraint error; FeltDB has no equivalent error type, so the refusal
   * is now a domain error with the same observable effect.
   */
  async bindTask(taskId: string, threadId: string) {
    await this.requireThread(threadId);
    const created = await this.felt.taskThreads.putIfAbsent(taskId, {
      taskId,
      threadId,
    });
    if (!created.inserted)
      throw new Error('That task is already bound to a conversation.');
  }

  async taskThread(taskId: string): Promise<string | undefined> {
    return (await this.felt.taskThreads.get(taskId))?.threadId;
  }

  async calls(threadId?: string): Promise<CallReceipt[]> {
    if (threadId) await this.requireThread(threadId);
    // `ORDER BY startedAt DESC`, ties in insertion order.
    return byStartedAtDescRowidDesc(
      (await this.felt.calls.all()).filter(
        (call) => !threadId || call.threadId === threadId,
      ),
    ).map(toCall);
  }

  async createCall(threadId: string): Promise<CallReceipt> {
    await this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    await this.felt.calls.putIfAbsent(call.id, { ...call, __version: 1 });
    return call;
  }

  async call(id: string): Promise<CallReceipt> {
    const record = await this.felt.calls.get(id);
    if (!record) throw new Error('Call not found.');
    const call = toCall(record);
    await this.requireThread(call.threadId);
    return call;
  }

  /**
   * Advance a call's status and transcript.
   *
   * A call that already has `endedAt` is terminal and is returned untouched, so
   * a late provider callback cannot reopen it.
   */
  async setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = await this.call(id);
    if (call.endedAt) return call;
    return this.writeCall(id, (record) => ({
      ...withoutStorageFields(record),
      status,
      transcript,
      error,
      endedAt:
        status === 'ended' || status === 'failed' ? Date.now() : record.endedAt,
    }));
  }

  /**
   * Record a transcript that arrived after the call ended.
   *
   * A compare-and-set: SQLite wrote only where `transcript='' AND endedAt IS NOT
   * NULL` and reported whether it changed anything. The predicate is re-checked
   * on every retry, so the boolean still means "this call wrote it".
   */
  async saveLateTranscript(id: string, transcript: string) {
    await this.call(id);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.felt.calls.get(id);
      if (!record) return false;
      if (record.transcript !== '' || record.endedAt === null) return false;
      try {
        await this.commit('call-late-transcript', (tx) => {
          tx.collection<CallRecord>('calls').set(
            id,
            {
              ...withoutStorageFields(record),
              transcript,
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

  async anchorCall(id: string, anchor: string | undefined) {
    await this.call(id);
    await this.writeCall(id, (record) => ({
      ...withoutStorageFields(record),
      anchorMessageId: anchor ?? null,
    }));
  }

  async setCallError(id: string, error: string | null) {
    await this.call(id);
    await this.writeCall(id, (record) => ({
      ...withoutStorageFields(record),
      error,
    }));
  }
  /** Read-evaluate-fenced-write, with the retry that makes the fence sound. */
  private async writeCall(
    id: string,
    build: (record: CallRecord) => CallRecord,
  ): Promise<CallReceipt> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.felt.calls.get(id);
      if (!record) throw new Error('Call not found.');
      const next: CallRecord = {
        ...build(record),
        __version: (record.__version ?? 1) + 1,
      };
      try {
        await this.commit('call-update', (tx) => {
          tx.collection<CallRecord>('calls').set(id, next, {
            expectedVersion: record.__version ?? 1,
          });
        });
        return toCall(next);
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
    throw new Error('That call changed too often to save.');
  }

  async saveCapture(threadId: string, value: unknown) {
    await this.requireThread(threadId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = await this.felt.captures.get(threadId);
      const version = existing?.__version ?? 0;
      try {
        await this.commit('capture-save', (tx) => {
          // Upsert, fenced on the version that was read: SQLite's
          // `ON CONFLICT(threadId) DO UPDATE SET value` with no lost update.
          tx.collection<CaptureRecord>('captures').set(
            threadId,
            { threadId, value, __version: version + 1 },
            existing ? { expectedVersion: version } : { requireAbsent: true },
          );
        });
        return;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
    throw new Error('That capture changed too often to save.');
  }

  async capture(threadId: string): Promise<unknown> {
    await this.requireThread(threadId);
    // SQLite read an absent row as NULL; so does FeltDB here.
    return (await this.felt.captures.get(threadId))?.value ?? null;
  }
}

/** Strip storage metadata; `CallReceipt` already carries a domain `id`. */
function toCall(record: CallRecord): CallReceipt {
  const { __version: _fence, ...rest } = record;
  void _fence;
  const call: CallReceipt = {
    id: record.id,
    threadId: record.threadId,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    status: record.status,
    transcript: record.transcript,
    error: record.error,
  };
  // `anchorMessageId` was added after the fact and stays absent until anchored.
  if (record.anchorMessageId !== undefined)
    call.anchorMessageId = record.anchorMessageId;
  void rest;
  return call;
}
