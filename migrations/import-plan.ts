/**
 * Convert a legacy snapshot into the canonical FeltDB records.
 *
 * Pure and side-effect free: it reads a snapshot and returns a plan plus every
 * problem it found. No database, no filesystem, no module-level state. That is
 * what lets `--dry-run` and the real run share exactly one validation path, and
 * what makes each conversion directly unit-testable.
 *
 * The record shapes are the runtime's own. There is deliberately no second
 * schema definition here.
 */
import { reviewKey } from '../src/server/pages.js';
import { eventKey, SETTINGS_KEY } from '../src/server/store-collections.js';
import {
  grantKey,
  pageThreadKey,
} from '../src/server/workspace-collections.js';
import type { LegacySnapshot } from './legacy-sqlite.js';

export interface MigrationProblem {
  collection: string;
  id: string;
  message: string;
}

/** One FeltDB write, expressed independently of any transaction builder. */
export interface PlannedWrite {
  collection: string;
  id: string;
  value: Record<string, unknown>;
  /**
   * When set, the record is written in the same transaction as this one, so a
   * half-applied pair can never be observed.
   */
  coupledTo?: string;
}

/**
 * Every collection this migration imports, in report order.
 *
 * Exported from the planner rather than the CLI so tests and tooling can assert
 * against it without importing `migrate.ts` — whose top level *runs* the
 * migration. `runtime-sqlite-guard.test.ts` cross-checks this against the
 * collections the runtime actually opens, so a collection can never be imported
 * without a runtime path, or vice versa.
 */
export const MIGRATED_COLLECTIONS = [
  'settings',
  'spaces',
  'dots',
  'dot_space_grants',
  'pages',
  'page_reviews',
  'thread_bindings',
  'page_threads',
  'page_thread_ids',
  'tasks',
  'task_threads',
  'runs',
  'task_events',
  'memories',
  'calls',
  'captures',
  'computer_permissions',
  'computer_audit',
] as const;

export interface MigrationPlan {
  writes: PlannedWrite[];
  problems: MigrationProblem[];
  counts: Record<string, number>;
  audit: {
    imported: number;
    retained: number;
    trimmed: number;
    trimmedIds: string[];
  };
  jsonParsed: number;
  /** Every 0/1 integer converted to a real boolean, across all domains. */
  boolsConverted: number;
  /** The subset of the above that came from `page_threads.ready`. */
  readyConverted: number;
}

/**
 * SQLite stored booleans as 0/1 integers.
 *
 * Only those two values are accepted. Anything else is a data problem worth
 * stopping for, not something to coerce: a `ready = 2` means the source was
 * written by something that disagrees with this schema.
 */
export function toBoolean(
  collection: string,
  id: string,
  raw: number,
): { value: boolean } | { problem: MigrationProblem } {
  if (raw === 0) return { value: false };
  if (raw === 1) return { value: true };
  return {
    problem: {
      collection,
      id,
      message: `expected 0 or 1 for a boolean, found ${JSON.stringify(raw)}`,
    },
  };
}

/**
 * Parse a JSON column into a structured value.
 *
 * Structure is preserved exactly — objects, arrays, strings, numbers, booleans
 * and null all round-trip. Malformed JSON is a failure rather than a silent
 * fallback to the raw string, because a string here would be indistinguishable
 * from a legitimately string-shaped capture downstream.
 */
export function parseJson(
  collection: string,
  id: string,
  raw: string,
): { value: unknown } | { problem: MigrationProblem } {
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch (error) {
    return {
      problem: {
        collection,
        id,
        message: `malformed JSON: ${(error as Error).message}`,
      },
    };
  }
}

/**
 * Which finished audit rows the runtime would keep for one Dot.
 *
 * The live policy (`ComputerStore.finish`) deletes, per Dot, every finished row
 * that is not among the newest `retention` by `createdAt DESC, rowid DESC`, and
 * never deletes a `pending` one. The legacy `rowid` has no FeltDB counterpart,
 * but the importer inserts audit rows in legacy `rowid` order, so insertion
 * order *is* the rowid order and the same comparison reproduces by sorting on it.
 */
export function selectAuditRetention(
  rows: { id: string; dotId: string; outcome: string; createdAt: number }[],
  retention: number,
): Set<string> {
  const byDot = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byDot.get(row.dotId);
    if (bucket) bucket.push(row);
    else byDot.set(row.dotId, [row]);
  }
  const trimmed = new Set<string>();
  for (const bucket of byDot.values()) {
    const newestFirst = [...bucket]
      .map((row, index) => ({ row, index }))
      .sort((a, b) =>
        b.row.createdAt === a.row.createdAt
          ? b.index - a.index
          : b.row.createdAt - a.row.createdAt,
      )
      .map((entry) => entry.row);
    const finished = newestFirst.filter((row) => row.outcome !== 'pending');
    for (const row of finished.slice(retention)) trimmed.add(row.id);
  }
  return trimmed;
}
export interface BuildOptions {
  /** Finished audit rows to keep per Dot; mirrors the runtime retention. */
  auditRetention: number;
}

/**
 * Renumber a task's events as the per-task sequence FeltDB addresses them by.
 *
 * `events.id` was a global AUTOINCREMENT counter, but the only read was
 * `WHERE taskId = ? ORDER BY id`, so the global gaps between two tasks were
 * never observable — only the order within a task was. The runtime allocates
 * `seq` the same way (`Store.nextEventSeq`: highest existing `seq` for the task,
 * plus one), so assigning `0, 1, 2 …` in legacy `id` order reproduces the log
 * exactly. No global counter is invented, because there is no global ordering to
 * preserve.
 */
export function assignEventSeq(
  rows: { id: number; taskId: string }[],
): Map<number, number> {
  const next = new Map<string, number>();
  const seq = new Map<number, number>();
  for (const row of rows) {
    const value = next.get(row.taskId) ?? 0;
    seq.set(row.id, value);
    next.set(row.taskId, value + 1);
  }
  return seq;
}

/**
 * Build the full import plan for a snapshot.
 *
 * Ordering matters in exactly one place: audit rows are emitted in legacy
 * `rowid` order, so insertion order reproduces the legacy tiebreak for every
 * later read.
 */
export function buildPlan(
  snapshot: LegacySnapshot,
  options: BuildOptions,
): MigrationPlan {
  const writes: PlannedWrite[] = [];
  const problems: MigrationProblem[] = [];
  const counts: Record<string, number> = {};
  let jsonParsed = 0;
  let boolsConverted = 0;
  let readyConverted = 0;

  const add = (
    collection: string,
    id: string,
    value: Record<string, unknown>,
    coupledTo?: string,
  ) => {
    writes.push({ collection, id, value, coupledTo });
    counts[collection] = (counts[collection] ?? 0) + 1;
  };
  const fail = (problem: MigrationProblem) => problems.push(problem);

  if (snapshot.settings) {
    const parsed = parseJson('settings', SETTINGS_KEY, snapshot.settings.value);
    if ('problem' in parsed) fail(parsed.problem);
    else {
      jsonParsed++;
      add('settings', SETTINGS_KEY, parsed.value as Record<string, unknown>);
    }
  }

  for (const row of snapshot.spaces)
    add('spaces', row.id, row as unknown as Record<string, unknown>);

  for (const row of snapshot.dots) {
    const research = toBoolean('dots', row.id, row.researchAllowed);
    const memory = toBoolean('dots', row.id, row.memoryAllowed);
    const skill = toBoolean('dots', row.id, row.skillDeliveryEnabled);
    for (const result of [research, memory, skill])
      if ('problem' in result) fail(result.problem);
    if ('problem' in research || 'problem' in memory || 'problem' in skill)
      continue;
    boolsConverted += 3;
    add('dots', row.id, {
      id: row.id,
      spaceId: row.spaceId,
      name: row.name,
      instructions: row.instructions,
      researchAllowed: research.value,
      memoryAllowed: memory.value,
      createdAt: row.createdAt,
      learningContainerId: row.learningContainerId,
      skillDeliveryEnabled: skill.value,
    });
  }

  for (const row of snapshot.grants)
    add('dot_space_grants', grantKey(row.dotId, row.spaceId), {
      dotId: row.dotId,
      spaceId: row.spaceId,
    });

  for (const row of snapshot.pages)
    add('pages', row.id, {
      id: row.id,
      spaceId: row.spaceId,
      parentId: row.parentId,
      title: row.title,
      content: row.content,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sourceThreadId: row.sourceThreadId,
    });

  // A review receipt is addressed by the (thread, tool call) pair it was created
  // for, using the same digest the runtime uses — never by the page it points at.
  for (const row of snapshot.pageReviews)
    add('page_reviews', reviewKey(row.threadId, row.toolCallId), {
      pageId: row.pageId,
      spaceId: row.spaceId,
    });

  for (const row of snapshot.tasks)
    add('tasks', row.id, {
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      intervalSeconds: row.intervalSeconds,
      nextRunAt: row.nextRunAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      error: row.error,
      lease: row.lease,
      leaseUntil: row.leaseUntil,
    });

  for (const row of snapshot.threadBindings)
    add('thread_bindings', row.id, row as unknown as Record<string, unknown>);
  // A reservation and its thread marker are one logical record. SQLite
  // enforced `UNIQUE(threadId)` with an index; the migration reproduces it as a
  // create-only marker written in the same transaction.
  const anchoredIn = new Map<string, string>();
  for (const row of snapshot.pageThreads) {
    const key = pageThreadKey(row.pageId, row.dotId);
    const ready = toBoolean('page_threads', key, row.ready);
    if ('problem' in ready) {
      fail(ready.problem);
      continue;
    }
    boolsConverted++;
    readyConverted++;
    // A conversation may anchor at most one page. Choosing a winner for a
    // duplicate would silently lose a reservation, so this stops the migration.
    const claimedBy = anchoredIn.get(row.threadId);
    if (claimedBy !== undefined && claimedBy !== key) {
      fail({
        collection: 'page_thread_ids',
        id: row.threadId,
        message: `thread anchored to more than one reservation: ${claimedBy} and ${key}`,
      });
      continue;
    }
    anchoredIn.set(row.threadId, key);
    add(
      'page_threads',
      key,
      {
        pageId: row.pageId,
        dotId: row.dotId,
        threadId: row.threadId,
        ready: ready.value,
        leaseUntil: row.leaseUntil,
      },
      row.threadId,
    );
    add('page_thread_ids', row.threadId, { threadId: row.threadId });
  }

  for (const row of snapshot.taskThreads)
    add('task_threads', row.taskId, {
      taskId: row.taskId,
      threadId: row.threadId,
    });

  for (const row of snapshot.runs) {
    // `result` was JSON text in SQLite and is a structured document here, so a
    // NULL stays NULL and anything present must parse.
    if (row.result === null) {
      add('runs', row.id, {
        id: row.id,
        taskId: row.taskId,
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        result: null,
        error: row.error,
      });
      continue;
    }
    const parsed = parseJson('runs', row.id, row.result);
    if ('problem' in parsed) {
      fail(parsed.problem);
      continue;
    }
    jsonParsed++;
    add('runs', row.id, {
      id: row.id,
      taskId: row.taskId,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      result: parsed.value,
      error: row.error,
    });
  }

  const eventSeq = assignEventSeq(snapshot.events);
  for (const row of snapshot.events) {
    const seq = eventSeq.get(row.id)!;
    add('task_events', eventKey(row.taskId, seq), {
      taskId: row.taskId,
      runId: row.runId,
      text: row.text,
      createdAt: row.createdAt,
      seq,
    });
  }

  for (const row of snapshot.memories)
    add('memories', row.id, {
      id: row.id,
      text: row.text,
      createdAt: row.createdAt,
    });

  for (const row of snapshot.calls)
    add('calls', row.id, {
      id: row.id,
      threadId: row.threadId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      status: row.status,
      transcript: row.transcript,
      error: row.error,
      // `anchorMessageId` was added after the table was created; an absent
      // column must stay absent rather than become an explicit null.
      ...(row.anchorMessageId === null || row.anchorMessageId === undefined
        ? {}
        : { anchorMessageId: row.anchorMessageId }),
    });

  for (const row of snapshot.captures) {
    const parsed = parseJson('captures', row.threadId, row.value);
    if ('problem' in parsed) {
      fail(parsed.problem);
      continue;
    }
    jsonParsed++;
    add('captures', row.threadId, {
      threadId: row.threadId,
      value: parsed.value,
    });
  }

  for (const row of snapshot.permissions) {
    const parsed = parseJson('computer_permissions', row.dotId, row.value);
    if ('problem' in parsed) {
      fail(parsed.problem);
      continue;
    }
    jsonParsed++;
    const value = parsed.value as Record<string, unknown>;
    let valid = true;
    for (const field of ['enabled', 'browser', 'files', 'shell']) {
      if (typeof value[field] === 'boolean') continue;
      valid = false;
      fail({
        collection: 'computer_permissions',
        id: row.dotId,
        message: `permission field ${field} must be a boolean`,
      });
    }
    if (!valid) continue;
    add('computer_permissions', row.dotId, { dotId: row.dotId, ...value });
  }

  const trimmedIds = selectAuditRetention(
    snapshot.audit,
    options.auditRetention,
  );
  for (const row of snapshot.audit) {
    if (trimmedIds.has(row.id)) continue;
    add('computer_audit', row.id, {
      id: row.id,
      dotId: row.dotId,
      action: row.action,
      actor: row.actor,
      outcome: row.outcome,
      createdAt: row.createdAt,
    });
  }

  return {
    writes,
    problems,
    counts,
    audit: {
      imported: snapshot.audit.length,
      retained: snapshot.audit.length - trimmedIds.size,
      trimmed: trimmedIds.size,
      trimmedIds: [...trimmedIds],
    },
    jsonParsed,
    boolsConverted,
    readyConverted,
  };
}
