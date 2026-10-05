import type { Collection, StateFirstDB } from '@feltdb/core';
import type {
  Memory,
  Result,
  Run,
  Settings,
  Task,
  TaskEvent,
  ManagedConfiguration,
} from '../shared/types.js';
import {
  byTimestampDesc,
  isLostRace,
  transactionId,
  withDomainId,
  withoutStorageFields,
  type StorageFence,
} from './felt/records.js';

export { isLostRace, transactionId };
export { byTimestampDesc as byCreatedAtDesc };
export type { StorageFence };

/**
 * FeltDB storage for the state `Store` owns: settings, tasks, runs, task
 * events and memories.
 *
 * Every field name matches the SQLite column it replaces, so `toTask`,
 * `toRun`, `toEvent` and `toMemory` are pure storage-metadata strips. Secrets
 * are deliberately absent: API keys and other credentials live in the process
 * environment and reach the application through `PlatformConfig`.
 */

/** The single settings row. The fixed key makes the singleton explicit. */
export interface SettingsRecord extends Settings, StorageFence {}

export interface TaskRecord extends Task, StorageFence {}

/**
 * One execution attempt. `id` is the lease UUID, exactly as in SQLite, so a
 * claim and its run are addressed by the same value.
 */
export interface RunRecord extends Omit<Run, 'result'>, StorageFence {
  /** Structured rather than JSON text: FeltDB stores documents, not blobs. */
  result: Result | null;
}

/**
 * One entry in a task's event log.
 *
 * `seq` is the SQLite `events.id`: a per-task sequence, because the only read
 * is `WHERE taskId=? ORDER BY id`. The global AUTOINCREMENT counter was storage
 * scaffolding for that ordering and is not reproduced. The composite key uses
 * `.` because FeltDB rejects `:` in a staged operation id.
 */
export interface EventRecord extends Omit<TaskEvent, 'id'>, StorageFence {
  /** Per-task ordinal; exposed as the domain `TaskEvent.id`. */
  seq: number;
}

export interface MemoryRecord extends Memory, StorageFence {}

/**
 * Managed configuration persisted through FeltDB.
 * Stores non-secret configuration that can be edited through the UI.
 */
export interface ConfigurationRecord extends ManagedConfiguration, StorageFence {}

/** The one key the settings singleton lives at. */
export const SETTINGS_KEY = 'settings';

export interface StoreCollections {
  settings: Collection<SettingsRecord>;
  tasks: Collection<TaskRecord>;
  runs: Collection<RunRecord>;
  events: Collection<EventRecord>;
  memories: Collection<MemoryRecord>;
  configurations: Collection<ConfigurationRecord>;
}

export function storeCollections(db: StateFirstDB): StoreCollections {
  return {
    settings: db.collection<SettingsRecord>('settings'),
    tasks: db.collection<TaskRecord>('tasks'),
    runs: db.collection<RunRecord>('runs'),
    events: db.collection<EventRecord>('task_events'),
    memories: db.collection<MemoryRecord>('memories'),
    configurations: db.collection<ConfigurationRecord>('configurations'),
  };
}

/** Composite key for one event of one task. */
export function eventKey(taskId: string, seq: number) {
  return `${taskId}.${String(seq).padStart(12, '0')}`;
}

/**
 * Strip FeltDB's own metadata before a record crosses the application boundary.
 *
 * `put`/`insert`/`putIfAbsent` all write an `id` of their own into whatever they
 * store. Every domain record here already carries its own `id` column, so the
 * storage copy is replaced rather than removed — see `toEvent`, where the id is
 * derived from `seq` instead.
 */
export function toTask(record: TaskRecord): Task {
  return { ...withoutStorageFields(record), id: record.id };
}

export function toRun(record: RunRecord): Run {
  return { ...withoutStorageFields(record), id: record.id };
}

export function toEvent(record: EventRecord): TaskEvent {
  return withDomainId(record, (event) => ({ ...event, id: event.seq }));
}

export function toMemory(record: MemoryRecord): Memory {
  return { ...withoutStorageFields(record), id: record.id };
}

/**
 * Strip storage metadata and the injected record id from the settings record.
 *
 * `Settings` is the one domain record here with no `id` field, so the injected
 * one has to be removed rather than replaced — otherwise the singleton would leak
 * `id: 'settings'` into every settings response.
 */
export function toSettings(record: SettingsRecord): Settings {
  const {
    __version: _fence,
    id: _id,
    ...settings
  } = record as SettingsRecord & { id?: string };
  void _fence;
  void _id;
  return settings;
}

export function toConfiguration(record: ConfigurationRecord): ManagedConfiguration {
  return { ...withoutStorageFields(record), id: record.id };
}
