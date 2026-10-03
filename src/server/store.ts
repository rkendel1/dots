import { randomUUID } from 'node:crypto';
import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import type {
  Action,
  Detail,
  Memory,
  Result,
  Run,
  Settings,
  Task,
} from '../shared/types.js';
import {
  byCreatedAtDesc,
  eventKey,
  isLostRace,
  SETTINGS_KEY,
  storeCollections,
  toEvent,
  toMemory,
  toRun,
  toSettings,
  toTask,
  transactionId,
  type EventRecord,
  type RunRecord,
  type SettingsRecord,
  type StoreCollections,
  type TaskRecord,
} from './store-collections.js';

export type Claim = Task & { lease: string };

const defaults: Settings = {
  name: 'Dot',
  paused: false,
  researchAllowed: true,
  memoryAllowed: true,
};

/**
 * How long a claim stays valid. SQLite used the same figure, and there is no
 * renewal: `Runner` pairs this with a 100 ms ownership poll and a 90 s run cap.
 */
const LEASE_MS = 180_000;

/**
 * How many times a mutation re-reads and retries after losing a conditional
 * write. Every retry uses a fresh transaction id, so none of them can be
 * silently deduplicated by FeltDB's replay protection.
 */
const MAX_ATTEMPTS = 8;

/**
 * The primary application store: settings, scheduled tasks, runs, task event
 * logs and memories.
 *
 * The durable state is FeltDB and this class is its only owner. The constructor
 * receives an already-open `StateFirstDB`; nothing here creates a runtime, opens
 * a second database, or closes the state — `FeltState` owns that lifecycle.
 *
 * SQLite gave every mutation a `BEGIN IMMEDIATE` write lock. FeltDB has no
 * equivalent, so that guarantee is reproduced explicitly: read the records a
 * decision depends on, evaluate the domain rule, then commit those records
 * fenced on the versions that were read. A writer that lost the race sees
 * `PRECONDITION_FAILED`, re-reads, and decides again.
 */
export class Store {
  private readonly state: StateFirstDB;
  private readonly felt: StoreCollections;

  constructor(state: StateFirstDB) {
    this.state = state;
    this.felt = storeCollections(state);
  }

  /**
   * Commit a staged transaction under a unique id.
   *
   * The id is deliberately never reused: a second commit with the same id
   * reports `duplicate: true` and applies nothing, which would silently drop a
   * mutation the caller was promised.
   */
  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }

  /**
   * The one settings record.
   *
   * Seeded on first read, which is the async equivalent of SQLite's
   * `INSERT OR IGNORE`: the defaults appear exactly when the record is absent,
   * concurrent first readers converge on a single winner, and an existing
   * record is never overwritten. No secret is stored here; credentials stay in
   * the process environment and reach the app through `PlatformConfig`.
   */
  async settings(): Promise<Settings> {
    const stored = await this.felt.settings.get(SETTINGS_KEY);
    if (stored) return toSettings(stored);
    const created = await this.felt.settings.putIfAbsent(SETTINGS_KEY, {
      ...defaults,
    });
    return toSettings(created.value);
  }

  /** Newest task first, as `ORDER BY createdAt DESC` returned. */
  async tasks(): Promise<Task[]> {
    return byCreatedAtDesc(await this.felt.tasks.all()).map(toTask);
  }

  async task(id: string): Promise<Task | undefined> {
    const record = await this.felt.tasks.get(id);
    return record ? toTask(record) : undefined;
  }
  /**
   * Merge a settings patch, and stop running work when a permission is revoked.
   *
   * One transaction, matching the `BEGIN IMMEDIATE` that previously spanned the
   * settings write and every task it invalidated. Settings and each task are
   * fenced on the version that was read, so a concurrent cancellation is never
   * overwritten by a last-writer-wins settings change.
   */
  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const stored = await this.felt.settings.get(SETTINGS_KEY);
      const previous = stored ? toSettings(stored) : defaults;
      const settings = { ...previous, ...patch };
      const revokes =
        (!previous.paused && settings.paused) ||
        (previous.researchAllowed && !settings.researchAllowed) ||
        (previous.memoryAllowed && !settings.memoryAllowed);
      const running = revokes
        ? (await this.felt.tasks.all()).filter(
            (task) => task.status === 'running',
          )
        : [];
      const stopped = await this.planInvalidations(
        running,
        'queued',
        'Run stopped because settings changed.',
      );
      try {
        await this.commit('settings', (tx) => {
          tx.collection<SettingsRecord>('settings').set(
            SETTINGS_KEY,
            { ...settings, __version: (stored?.__version ?? 0) + 1 },
            // `updateSettings` can legitimately be the first writer, because
            // `settings()` seeds lazily rather than in a constructor. A create
            // is therefore create-only; an update is fenced on the version read.
            stored
              ? { expectedVersion: stored.__version }
              : { requireAbsent: true },
          );
          this.stageInvalidations(tx, stopped);
        });
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
      return settings;
    }
    throw new Error('Settings changed too often to apply. Try again.');
  }

  /**
   * Queue a task and record that it was queued.
   *
   * SQLite issued these as two separate statements. They are one transaction
   * here because a task without its first event is a state the UI cannot
   * explain; this removes a torn-write window rather than adding coupling.
   */
  async createTask(
    prompt: string,
    intervalSeconds: number | null = null,
  ): Promise<Task> {
    const now = Date.now();
    const id = randomUUID();
    const task: Task = {
      id,
      prompt,
      status: 'queued',
      intervalSeconds,
      nextRunAt: null,
      createdAt: now,
      updatedAt: now,
      error: null,
      lease: null,
      leaseUntil: null,
    };
    await this.commit('task-create', (tx) => {
      tx.collection<TaskRecord>('tasks').set(id, { ...task, __version: 1 });
      tx.collection<EventRecord>('task_events').set(
        eventKey(id, 0),
        this.eventRecord(id, null, 'Task added to the research queue.', 0, now),
        { requireAbsent: true },
      );
    });
    return task;
  }

  /**
   * A task with its runs and event log.
   *
   * Run order reproduces `ORDER BY startedAt DESC, rowid DESC`. FeltDB returns
   * insertion (rowid) order, so the list is reversed before the stable sort by
   * `startedAt`: equal timestamps then resolve newest-first, exactly as the
   * explicit `rowid DESC` tiebreak did.
   */
  async detail(id: string): Promise<Detail | undefined> {
    const task = await this.felt.tasks.get(id);
    if (!task) return undefined;
    const runs = (await this.felt.runs.all())
      .filter((run) => run.taskId === id)
      .reverse()
      .sort((a, b) => b.startedAt - a.startedAt);
    const events = (await this.felt.events.all())
      .filter((event) => event.taskId === id)
      .sort((a, b) => a.seq - b.seq);
    return {
      task: toTask(task),
      runs: runs.map(toRun),
      events: events.map(toEvent),
    };
  }
  /**
   * Append one entry to a task's event log.
   *
   * The sequence is allocated from the events already stored for that task and
   * the append is create-only, so two writers appending at once cannot collide
   * destructively: the loser's `requireAbsent` guard refuses the whole
   * transaction, and it retries against the next sequence.
   */
  async event(taskId: string, runId: string | null, text: string) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const seq = await this.nextEventSeq(taskId);
      const record = this.eventRecord(taskId, runId, text, seq, Date.now());
      try {
        await this.commit('event', (tx) => {
          tx.collection<EventRecord>('task_events').set(
            eventKey(taskId, seq),
            record,
            { requireAbsent: true },
          );
        });
        return;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
    throw new Error('This task log is too busy to record another event.');
  }

  /**
   * The next per-task event sequence.
   *
   * SQLite's `events.id` was a global AUTOINCREMENT counter, but the only read
   * was `WHERE taskId=? ORDER BY id`, so ordering was only ever needed within
   * one task. A per-task sequence is the faithful and minimal replacement; no
   * global ordering mechanism is introduced.
   */
  private async nextEventSeq(taskId: string) {
    let highest = -1;
    for (const event of await this.felt.events.all())
      if (event.taskId === taskId && event.seq > highest) highest = event.seq;
    return highest + 1;
  }

  private eventRecord(
    taskId: string,
    runId: string | null,
    text: string,
    seq: number,
    createdAt: number,
  ): EventRecord {
    return { taskId, runId, text, createdAt, seq };
  }

  /**
   * Plan a batch of invalidations against the current state.
   *
   * Every caller that stops a task shares this shape: the task loses its lease,
   * the run it still holds is marked `interrupted`, and the reason is logged.
   * The reads happen here, before anything is staged, so each subsequent write
   * can be fenced on the exact version it was derived from.
   */
  private async planInvalidations(
    tasks: TaskRecord[],
    status: string,
    reason: string,
    now = Date.now(),
  ) {
    const planned = [];
    for (const task of tasks) {
      planned.push({
        task,
        run: task.lease ? await this.felt.runs.get(task.lease) : null,
        seq: await this.nextEventSeq(task.id),
        next: {
          ...toTask(task),
          status: status as Task['status'],
          lease: null,
          leaseUntil: null,
          updatedAt: now,
        } satisfies Task,
      });
    }
    return { planned, reason, now };
  }

  /**
   * Stage a planned batch: one run, one task and one logged reason each.
   *
   * `skipTask` lets a caller that has already staged its own version of a task
   * row opt out of the generic one, so no record is written twice inside a
   * single transaction.
   */
  private stageInvalidations(
    tx: AtomicTransactionScope,
    plan: Awaited<ReturnType<Store['planInvalidations']>>,
    options: { skipTask?: string } = {},
  ) {
    for (const { task, run, seq, next } of plan.planned) {
      if (run) {
        // SQLite guarded this with `AND status='running'`, so a run that had
        // already reached a terminal state was left alone.
        tx.collection<RunRecord>('runs').set(
          run.id,
          {
            ...toRun(run),
            status: 'interrupted',
            finishedAt: plan.now,
            error: plan.reason,
            __version: (run.__version ?? 1) + 1,
          },
          { expectedVersion: run.__version ?? 1 },
        );
      }
      if (task.id !== options.skipTask)
        tx.collection<TaskRecord>('tasks').set(
          task.id,
          { ...next, __version: (task.__version ?? 1) + 1 },
          { expectedVersion: task.__version ?? 1 },
        );
      tx.collection<EventRecord>('task_events').set(
        eventKey(task.id, seq),
        this.eventRecord(task.id, task.lease, plan.reason, seq, plan.now),
        { requireAbsent: true },
      );
    }
  }
  /**
   * Apply a user action to a task.
   *
   * `run` on an already-running task is a no-op, as before. Every other action
   * clears the lease, drops any stored error and pending repeat, and records
   * why — all in one transaction, as SQLite's `BEGIN IMMEDIATE` did.
   */
  async action(id: string, action: Action): Promise<Task | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const task = await this.felt.tasks.get(id);
      if (!task) return undefined;
      if (action === 'run' && task.status === 'running') return toTask(task);
      const status =
        action === 'run'
          ? 'queued'
          : action === 'pause'
            ? 'paused'
            : 'cancelled';
      const plan = await this.planInvalidations(
        [task],
        status,
        action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`,
      );
      try {
        await this.commit('task-action', (tx) => {
          // `error` and `nextRunAt` were cleared by a second SQLite statement
          // on the same row; folding them into the one staged write keeps a
          // single fence per record, which is what makes the retry sound.
          tx.collection<TaskRecord>('tasks').set(
            id,
            {
              ...plan.planned[0]!.next,
              error: null,
              nextRunAt: null,
              __version: (task.__version ?? 1) + 1,
            },
            { expectedVersion: task.__version ?? 1 },
          );
          this.stageInvalidations(tx, plan, { skipTask: id });
        });
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
      return this.task(id);
    }
    return undefined;
  }

  /**
   * Set or clear a repeat interval.
   *
   * Only a completed task gets a pending run time; anything else waits for its
   * next completion to schedule from, which is what SQLite did.
   */
  async schedule(
    id: string,
    intervalSeconds: number | null,
  ): Promise<Task | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const task = await this.felt.tasks.get(id);
      if (!task) return undefined;
      const now = Date.now();
      const nextRunAt =
        intervalSeconds && task.status === 'completed'
          ? now + intervalSeconds * 1000
          : null;
      const text = intervalSeconds
        ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
        : 'Repeat schedule removed.';
      const seq = await this.nextEventSeq(id);
      try {
        await this.commit('task-schedule', (tx) => {
          tx.collection<TaskRecord>('tasks').set(
            id,
            {
              ...toTask(task),
              intervalSeconds,
              nextRunAt,
              updatedAt: now,
              __version: (task.__version ?? 1) + 1,
            },
            { expectedVersion: task.__version ?? 1 },
          );
          tx.collection<EventRecord>('task_events').set(
            eventKey(id, seq),
            this.eventRecord(id, null, text, seq, now),
            { requireAbsent: true },
          );
        });
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
      return this.task(id);
    }
    return undefined;
  }
  /**
   * Take the next available task, or nothing.
   *
   * Expired leases are reclaimed first, exactly as before: a worker that died
   * mid-run leaves a task `running` past `leaseUntil`, and the next claim
   * requeues it with an explicit reason.
   *
   * The claim itself is fenced on the candidate's version, so when two workers
   * race for the same queued task exactly one wins the lease, creates its run
   * and logs the start. The loser sees a lost race, re-reads, and either takes a
   * different task or returns `null` — the same outcome `BEGIN IMMEDIATE`
   * produced.
   */
  async claim(now = Date.now()): Promise<Claim | null> {
    const settings = await this.settings();
    if (settings.paused || !settings.researchAllowed) return null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const records = await this.felt.tasks.all();
      const expired = records.filter(
        (task) =>
          task.status === 'running' &&
          task.lease !== null &&
          (task.leaseUntil ?? 0) <= now,
      );
      // Oldest first, as `ORDER BY createdAt LIMIT 1` selected.
      const available = records
        .filter(
          (task) =>
            task.status === 'queued' ||
            (task.status === 'completed' &&
              task.nextRunAt !== null &&
              task.nextRunAt <= now),
        )
        .sort((a, b) => a.createdAt - b.createdAt);
      const stale =
        expired.length > 0
          ? await this.planInvalidations(
              expired,
              'queued',
              'Previous worker lease expired; safely retrying.',
              now,
            )
          : null;
      if (!available.length) {
        if (!stale) return null;
        // Only expired leases left: reclaim them, then look again.
        try {
          await this.commit('lease-expire', (tx) =>
            this.stageInvalidations(tx, stale),
          );
        } catch (error) {
          if (!isLostRace(error)) throw error;
        }
        continue;
      }
      const task = available[0]!;
      const version = task.__version ?? 1;
      const lease = randomUUID();
      const claimed: Task = {
        ...toTask(task),
        status: 'running',
        lease,
        leaseUntil: now + LEASE_MS,
        nextRunAt: null,
        error: null,
        updatedAt: now,
      };
      // The run's id is the lease, exactly as in SQLite.
      const run: Run = {
        id: lease,
        taskId: task.id,
        status: 'running',
        startedAt: now,
        finishedAt: null,
        result: null,
        error: null,
      };
      const seq = await this.nextEventSeq(task.id);
      try {
        await this.commit('task-claim', (tx) => {
          if (stale) this.stageInvalidations(tx, stale);
          tx.collection<TaskRecord>('tasks').set(
            task.id,
            { ...claimed, __version: version + 1 },
            { expectedVersion: version },
          );
          tx.collection<RunRecord>('runs').set(lease, { ...run, __version: 1 });
          tx.collection<EventRecord>('task_events').set(
            eventKey(task.id, seq),
            this.eventRecord(
              task.id,
              lease,
              'Research worker started.',
              seq,
              now,
            ),
            { requireAbsent: true },
          );
        });
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
      return { ...claimed, lease };
    }
    return null;
  }

  /** Whether this claim still holds the task. */
  async owns(claim: Claim): Promise<boolean> {
    const task = await this.felt.tasks.get(claim.id);
    return task?.status === 'running' && task.lease === claim.lease;
  }
  /**
   * Complete a run.
   *
   * Returns `false`, having written nothing, when the claim no longer owns the
   * task. That is the guarantee that a late worker cannot overwrite a
   * cancellation or a newer claim, and it is stronger than the original: the
   * ownership test and the write are one fenced commit, so the answer cannot go
   * stale between the check and the write.
   */
  async finish(
    claim: Claim,
    result: Result,
    now = Date.now(),
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const task = await this.felt.tasks.get(claim.id);
      if (task?.status !== 'running' || task.lease !== claim.lease)
        return false;
      const version = task.__version ?? 1;
      const text = result.sample
        ? 'Fictional sample brief ready.'
        : 'Research brief ready.';
      const seq = await this.nextEventSeq(claim.id);
      try {
        await this.commit('task-finish', (tx) => {
          tx.collection<RunRecord>('runs').set(
            claim.lease,
            {
              id: claim.lease,
              taskId: claim.id,
              status: 'completed',
              startedAt: now,
              finishedAt: now,
              result,
              error: null,
              __version: 2,
            },
            { expectedVersion: 1 },
          );
          tx.collection<TaskRecord>('tasks').set(
            claim.id,
            {
              ...toTask(task),
              status: 'completed',
              lease: null,
              leaseUntil: null,
              updatedAt: now,
              nextRunAt: task.intervalSeconds
                ? now + task.intervalSeconds * 1000
                : null,
              __version: version + 1,
            },
            { expectedVersion: version },
          );
          tx.collection<EventRecord>('task_events').set(
            eventKey(claim.id, seq),
            this.eventRecord(claim.id, claim.lease, text, seq, now),
            { requireAbsent: true },
          );
        });
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
      return true;
    }
    return false;
  }

  /** Hand a claimed task back to the queue. */
  async release(claim: Claim, reason: string) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const task = await this.felt.tasks.get(claim.id);
      if (task?.status !== 'running' || task.lease !== claim.lease) return;
      const plan = await this.planInvalidations([task], 'queued', reason);
      try {
        await this.commit('task-release', (tx) =>
          this.stageInvalidations(tx, plan),
        );
        return;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
  }

  /**
   * Record a failed run.
   *
   * Silently does nothing when the claim was superseded, so a failure arriving
   * after a cancellation cannot resurrect the task as `failed`.
   */
  async fail(claim: Claim, error: string) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const task = await this.felt.tasks.get(claim.id);
      if (task?.status !== 'running' || task.lease !== claim.lease) return;
      const now = Date.now();
      const version = task.__version ?? 1;
      const seq = await this.nextEventSeq(claim.id);
      try {
        await this.commit('task-fail', (tx) => {
          tx.collection<RunRecord>('runs').set(
            claim.lease,
            {
              id: claim.lease,
              taskId: claim.id,
              status: 'failed',
              startedAt: now,
              finishedAt: now,
              result: null,
              error,
              __version: 2,
            },
            { expectedVersion: 1 },
          );
          tx.collection<TaskRecord>('tasks').set(
            claim.id,
            {
              ...toTask(task),
              status: 'failed',
              lease: null,
              leaseUntil: null,
              error,
              updatedAt: now,
              __version: version + 1,
            },
            { expectedVersion: version },
          );
          tx.collection<EventRecord>('task_events').set(
            eventKey(claim.id, seq),
            this.eventRecord(claim.id, claim.lease, error, seq, now),
            { requireAbsent: true },
          );
        });
        return;
      } catch (lost) {
        if (isLostRace(lost)) continue;
        throw lost;
      }
    }
  }
  /** Newest memory first, as `ORDER BY createdAt DESC` returned. */
  async memories(): Promise<Memory[]> {
    return byCreatedAtDesc(await this.felt.memories.all()).map(toMemory);
  }

  /**
   * Create or re-save a memory.
   *
   * Re-saving updates the text only: the original `createdAt` is preserved, so
   * editing a memory does not move it to the top of the list. The write is
   * fenced on the version that was read, and a create is create-only, so two
   * concurrent saves cannot lose each other's work silently.
   */
  async saveMemory(text: string, id: string = randomUUID()): Promise<Memory> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = await this.felt.memories.get(id);
      const memory: Memory = {
        id,
        text,
        createdAt: existing ? existing.createdAt : Date.now(),
      };
      const version = existing?.__version ?? 0;
      try {
        await this.commit('memory-save', (tx) => {
          tx.collection('memories').set(
            id,
            { ...memory, __version: version + 1 },
            existing ? { expectedVersion: version } : { requireAbsent: true },
          );
        });
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
      return memory;
    }
    throw new Error('That memory changed too often to save. Try again.');
  }

  async deleteMemory(id: string): Promise<boolean> {
    // FeltDB's delete is silent for a missing key in memory but throws on the
    // file runtime, so the existence check is what keeps this boolean honest on
    // both — and matches SQLite's `changes > 0`.
    if (!(await this.felt.memories.exists(id))) return false;
    await this.felt.memories.delete(id);
    return true;
  }
}
