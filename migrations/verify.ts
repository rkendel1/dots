/**
 * Independent verification of a completed migration.
 *
 * Deliberately written against the *source snapshot and the finished state*,
 * not against the plan: it re-derives what was written from the data itself.
 * Counts, identities, whole-record content, booleans, JSON structure,
 * relationships, ordering and retention are all recomputed here, and its own
 * structural comparison is written out separately from the planner's so a bug in
 * one cannot cancel itself out against the other.
 */
import type { StateFirstDB } from '@feltdb/core';
import { AUDIT_RETENTION } from '../src/server/computer-collections.js';
import {
  byStartedAtDescRowidDesc,
  byTimestampDesc,
} from '../src/server/felt/records.js';
import { reviewKey } from '../src/server/pages.js';
import { eventKey, SETTINGS_KEY } from '../src/server/store-collections.js';
import {
  grantKey,
  pageThreadKey,
} from '../src/server/workspace-collections.js';
import { assignEventSeq } from './import-plan.js';
import type { LegacySnapshot } from './legacy-sqlite.js';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  checks: Check[];
  ok: boolean;
}

/** Structural equality, insensitive to key order. */
function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((entry, index) => eq(entry, b[index]));
  }
  if (typeof a !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(
    (key) => right[key] !== undefined,
  );
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => key in right && eq(left[key], right[key]));
}

/**
 * Strip FeltDB's own fields from a stored record.
 *
 * `__version` is the storage fence and never compares. `id` is injected from the
 * record key by `set`/`put`/`insert`, so it is normalised to `undefined` only
 * for records whose domain shape has no `id` of its own; a Dot, a call or a page
 * genuinely owns one, and it still has to be compared.
 */
function domain(record: unknown): Record<string, unknown> {
  if (typeof record !== 'object' || record === null) return {};
  const stored = { ...(record as Record<string, unknown>) };
  delete stored.__version;
  return stored;
}

export async function verifyMigration(
  state: StateFirstDB,
  snapshot: LegacySnapshot,
  trimmedAuditIds: Set<string>,
): Promise<VerifyResult> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = '') =>
    checks.push({ name, ok, detail });
  const load = async (collection: string, id: string) =>
    domain(await state.collection(collection).get(id));

  const eventSeq = assignEventSeq(snapshot.events);

  // ---- counts, accounting for the two intentional differences ---------------
  const expected: Record<string, number> = {
    settings: snapshot.settings ? 1 : 0,
    spaces: snapshot.spaces.length,
    dots: snapshot.dots.length,
    dot_space_grants: snapshot.grants.length,
    pages: snapshot.pages.length,
    page_reviews: snapshot.pageReviews.length,
    thread_bindings: snapshot.threadBindings.length,
    page_threads: snapshot.pageThreads.length,
    // One synthesized marker per distinct anchored thread.
    page_thread_ids: new Set(snapshot.pageThreads.map((r) => r.threadId)).size,
    tasks: snapshot.tasks.length,
    task_threads: snapshot.taskThreads.length,
    runs: snapshot.runs.length,
    task_events: snapshot.events.length,
    memories: snapshot.memories.length,
    calls: snapshot.calls.length,
    captures: snapshot.captures.length,
    computer_permissions: snapshot.permissions.length,
    computer_audit: snapshot.audit.filter((r) => !trimmedAuditIds.has(r.id))
      .length,
  };
  for (const [collection, want] of Object.entries(expected)) {
    const got = (await state.collection(collection).all()).length;
    check(`count:${collection}`, got === want, `source ${want}, target ${got}`);
  }
  // ---- identities and whole-record content ----------------------------------
  // Each entry asserts the record exists at exactly the key the runtime would
  // use *and* that its domain content survived the trip. Presence alone would
  // let a silently mangled field through.
  const records: {
    name: string;
    collection: string;
    id: string;
    value: Record<string, unknown>;
  }[] = [];
  const expect = (
    name: string,
    collection: string,
    id: string,
    value: Record<string, unknown>,
  ) => records.push({ name, collection, id, value });

  if (snapshot.settings)
    expect(`settings:${SETTINGS_KEY}`, 'settings', SETTINGS_KEY, {
      ...(JSON.parse(snapshot.settings.value) as Record<string, unknown>),
    });
  for (const row of snapshot.spaces)
    expect(`spaces:${row.id}`, 'spaces', row.id, { ...row });
  for (const row of snapshot.dots)
    expect(`dots:${row.id}`, 'dots', row.id, {
      id: row.id,
      spaceId: row.spaceId,
      name: row.name,
      instructions: row.instructions,
      // The legacy 0/1 integers, compared as the booleans they became.
      researchAllowed: row.researchAllowed === 1,
      memoryAllowed: row.memoryAllowed === 1,
      createdAt: row.createdAt,
      learningContainerId: row.learningContainerId,
      skillDeliveryEnabled: row.skillDeliveryEnabled === 1,
    });
  for (const row of snapshot.grants)
    expect(
      `dot_space_grants:${row.dotId}/${row.spaceId}`,
      'dot_space_grants',
      grantKey(row.dotId, row.spaceId),
      { dotId: row.dotId, spaceId: row.spaceId },
    );
  for (const row of snapshot.pages)
    expect(`pages:${row.id}`, 'pages', row.id, { ...row });
  for (const row of snapshot.pageReviews)
    expect(
      `page_reviews:${row.threadId}/${row.toolCallId}`,
      'page_reviews',
      reviewKey(row.threadId, row.toolCallId),
      { pageId: row.pageId, spaceId: row.spaceId },
    );
  for (const row of snapshot.threadBindings)
    expect(`thread_bindings:${row.id}`, 'thread_bindings', row.id, { ...row });
  for (const row of snapshot.pageThreads) {
    const key = pageThreadKey(row.pageId, row.dotId);
    expect(`page_threads:${key}`, 'page_threads', key, {
      pageId: row.pageId,
      dotId: row.dotId,
      threadId: row.threadId,
      ready: row.ready === 1,
      leaseUntil: row.leaseUntil,
    });
    // The synthesized marker, at the runtime's own identity scheme.
    expect(`page_thread_ids:${row.threadId}`, 'page_thread_ids', row.threadId, {
      threadId: row.threadId,
    });
  }
  for (const row of snapshot.tasks)
    expect(`tasks:${row.id}`, 'tasks', row.id, { ...row });
  for (const row of snapshot.taskThreads)
    expect(`task_threads:${row.taskId}`, 'task_threads', row.taskId, {
      taskId: row.taskId,
      threadId: row.threadId,
    });
  for (const row of snapshot.runs)
    expect(`runs:${row.id}`, 'runs', row.id, {
      id: row.id,
      taskId: row.taskId,
      status: row.status,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      result: row.result === null ? null : JSON.parse(row.result),
      error: row.error,
    });
  for (const row of snapshot.events) {
    const seq = eventSeq.get(row.id)!;
    expect(
      `task_events:${row.taskId}#${seq}`,
      'task_events',
      eventKey(row.taskId, seq),
      {
        taskId: row.taskId,
        runId: row.runId,
        text: row.text,
        createdAt: row.createdAt,
        seq,
      },
    );
  }
  for (const row of snapshot.memories)
    expect(`memories:${row.id}`, 'memories', row.id, { ...row });
  for (const row of snapshot.calls)
    expect(`calls:${row.id}`, 'calls', row.id, {
      id: row.id,
      threadId: row.threadId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      status: row.status,
      transcript: row.transcript,
      error: row.error,
      // An absent ALTER TABLE column must stay absent, not become an explicit
      // null, so it is only compared when the source actually had one.
      ...(row.anchorMessageId == null
        ? {}
        : { anchorMessageId: row.anchorMessageId }),
    });
  for (const row of snapshot.captures)
    expect(`captures:${row.threadId}`, 'captures', row.threadId, {
      threadId: row.threadId,
      value: JSON.parse(row.value),
    });
  for (const row of snapshot.permissions)
    expect(
      `computer_permissions:${row.dotId}`,
      'computer_permissions',
      row.dotId,
      {
        dotId: row.dotId,
        ...(JSON.parse(row.value) as Record<string, unknown>),
      },
    );
  for (const row of snapshot.audit) {
    if (trimmedAuditIds.has(row.id)) continue;
    expect(`computer_audit:${row.id}`, 'computer_audit', row.id, { ...row });
  }
  for (const id of trimmedAuditIds)
    check(
      `trimmed:computer_audit:${id}`,
      !(await state.collection('computer_audit').get(id)),
    );

  for (const record of records) {
    const stored = await state.collection(record.collection).get(record.id);
    // A record whose domain shape has no `id` inherits one from its key, so the
    // injected field is normalised away on the stored side only — a record that
    // genuinely owns an `id` (a Dot, a call, a page) still has it compared.
    const hasDomainId = 'id' in record.value;
    const comparable = domain(
      hasDomainId || typeof stored !== 'object' || stored === null
        ? stored
        : { ...(stored as Record<string, unknown>), id: undefined },
    );
    const ok = eq(comparable, record.value);
    check(
      `record:${record.name}`,
      ok,
      ok
        ? ''
        : `stored ${JSON.stringify(comparable)} != planned ${JSON.stringify(record.value)}`,
    );
  }
  // ---- booleans ---------------------------------------------------------------
  // Checked as types, not merely as values: a legacy `ready = 2` would have been
  // truthy under a loose conversion, which is exactly what must never happen.
  for (const row of snapshot.pageThreads) {
    const key = pageThreadKey(row.pageId, row.dotId);
    const stored = await load('page_threads', key);
    check(
      `boolean:page_threads.ready:${row.threadId}`,
      typeof stored.ready === 'boolean' && stored.ready === (row.ready === 1),
      `ready is ${JSON.stringify(stored.ready)}`,
    );
  }
  for (const row of snapshot.dots) {
    const stored = await load('dots', row.id);
    check(
      `boolean:dots:${row.id}`,
      typeof stored.researchAllowed === 'boolean' &&
        typeof stored.memoryAllowed === 'boolean' &&
        typeof stored.skillDeliveryEnabled === 'boolean',
    );
  }

  // ---- relationships that actually exist in the schema ----------------------
  // Only references the code genuinely models are asserted. A Dot's `spaceId` is
  // its default page destination, not a membership edge — membership lives in
  // `dot_space_grants` — so it is checked as the Space reference it is, and no
  // foreign key is invented where the schema has none.
  const resolves = async (collection: string, id: string | null) =>
    id === null || !!(await state.collection(collection).get(id));

  for (const row of snapshot.dots)
    check(
      `relationship:dots→spaces:${row.id}`,
      await resolves('spaces', row.spaceId),
    );
  for (const row of snapshot.grants) {
    check(
      `relationship:grants→dots:${row.dotId}`,
      await resolves('dots', row.dotId),
    );
    check(
      `relationship:grants→spaces:${row.spaceId}`,
      await resolves('spaces', row.spaceId),
    );
  }
  for (const row of snapshot.pages) {
    check(
      `relationship:pages→spaces:${row.id}`,
      await resolves('spaces', row.spaceId),
    );
    check(
      `relationship:pages→pages:${row.id}`,
      await resolves('pages', row.parentId),
    );
  }
  for (const row of snapshot.pageReviews) {
    const name = `${row.threadId}/${row.toolCallId}`;
    check(
      `relationship:page_reviews→pages:${name}`,
      await resolves('pages', row.pageId),
    );
    check(
      `relationship:page_reviews→spaces:${name}`,
      await resolves('spaces', row.spaceId),
    );
  }
  for (const row of snapshot.pageThreads) {
    const key = pageThreadKey(row.pageId, row.dotId);
    check(
      `relationship:page_threads→pages:${key}`,
      await resolves('pages', row.pageId),
    );
    check(
      `relationship:page_threads→dots:${key}`,
      await resolves('dots', row.dotId),
    );
  }
  for (const row of snapshot.threadBindings)
    check(
      `relationship:thread_bindings→dots:${row.id}`,
      await resolves('dots', row.dotId),
    );
  for (const row of snapshot.taskThreads)
    check(
      `relationship:task_threads→tasks:${row.taskId}`,
      await resolves('tasks', row.taskId),
    );
  for (const row of snapshot.runs)
    check(
      `relationship:runs→tasks:${row.id}`,
      await resolves('tasks', row.taskId),
    );
  for (const row of snapshot.events) {
    const seq = eventSeq.get(row.id)!;
    check(
      `relationship:task_events→tasks:${row.taskId}#${seq}`,
      await resolves('tasks', row.taskId),
    );
    check(
      `relationship:task_events→runs:${row.taskId}#${seq}`,
      await resolves('runs', row.runId),
    );
  }
  // Calls and captures are both addressed by conversation, and the schema stores
  // those conversations in the thread collections above — the runtime's own
  // `calls()` and `capture()` look them up the same way.
  const threadExists = async (threadId: string) =>
    !!(await state.collection('thread_bindings').get(threadId)) ||
    !!(await state.collection('page_thread_ids').get(threadId));
  for (const row of snapshot.calls)
    check(
      `relationship:calls→threads:${row.id}`,
      await threadExists(row.threadId),
    );
  for (const row of snapshot.captures)
    check(
      `relationship:captures→threads:${row.threadId}`,
      await threadExists(row.threadId),
    );
  for (const row of snapshot.permissions)
    check(
      `relationship:computer_permissions→dots:${row.dotId}`,
      await resolves('dots', row.dotId),
    );
  for (const row of snapshot.audit) {
    if (trimmedAuditIds.has(row.id)) continue;
    check(
      `relationship:computer_audit→dots:${row.id}`,
      await resolves('dots', row.dotId),
    );
  }
  // ---- ordering ---------------------------------------------------------------
  /**
   * The runtime's tiebreak, and why the import order matters.
   *
   * `byStartedAtDescRowidDesc` and `Store.detail` both `reverse()` the whole
   * collection and then apply a *stable* descending sort by timestamp. FeltDB
   * returns insertion order, so that reversal reproduces SQLite's explicit
   * `rowid DESC` tiebreak — which only holds if the importer inserted rows in
   * legacy `rowid` order. The check below therefore compares the migrated
   * result against the legacy expectation *and* asserts the runtime's own sort
   * agrees, so a future change to either side is caught rather than assumed.
   */
  const callStamps = byStartedAtDescRowidDesc<{ startedAt: number }>(
    (await state.collection('calls').all()) as { startedAt: number }[],
  ).map((call) => call.startedAt);
  check(
    'ordering:calls newest first',
    callStamps.every((value, i) => i === 0 || callStamps[i - 1]! >= value),
    callStamps.join(','),
  );
  const legacyCallStamps = [...snapshot.calls]
    .reverse()
    .map((row) => row.startedAt)
    .sort((a, b) => b - a);
  check(
    'ordering:calls matches the legacy order',
    eq(callStamps, legacyCallStamps),
    `legacy ${legacyCallStamps.join(',')}`,
  );

  const runs = (await state.collection('runs').all()) as {
    taskId: string;
    startedAt: number;
  }[];
  for (const task of snapshot.tasks) {
    const legacyOrder = [...snapshot.runs]
      .map((row, index) => ({ row, index }))
      .sort((a, b) =>
        a.row.startedAt === b.row.startedAt
          ? b.index - a.index
          : b.row.startedAt - a.row.startedAt,
      )
      .filter((entry) => entry.row.taskId === task.id)
      .map((entry) => entry.row.startedAt);
    // `Store.detail` filters, then reverses the *whole* collection, then sorts.
    const actual = runs
      .filter((run) => run.taskId === task.id)
      .reverse()
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => run.startedAt);
    check(
      `ordering:runs for ${task.id}`,
      eq(actual, legacyOrder),
      `legacy ${legacyOrder.join(',')}`,
    );
  }

  const storedEvents = (await state.collection('task_events').all()) as {
    taskId: string;
    seq: number;
  }[];
  for (const task of snapshot.tasks) {
    const legacySeq = snapshot.events
      .filter((row) => row.taskId === task.id)
      .map((row) => eventSeq.get(row.id)!);
    const actual = storedEvents
      .filter((event) => event.taskId === task.id)
      .sort((a, b) => a.seq - b.seq)
      .map((event) => event.seq);
    check(
      `ordering:task_events for ${task.id}`,
      eq(actual, legacySeq),
      `legacy ${legacySeq.join(',')}`,
    );
  }

  for (const collection of ['tasks', 'memories', 'computer_audit']) {
    const stamps = byTimestampDesc(
      (await state.collection(collection).all()) as { createdAt: number }[],
    ).map((row) => row.createdAt);
    check(
      `ordering:${collection} newest first`,
      stamps.every((value, i) => i === 0 || stamps[i - 1]! >= value),
      stamps.join(','),
    );
  }

  // ---- audit retention -------------------------------------------------------
  // The live policy keeps the newest `AUDIT_RETENTION` *finished* rows per Dot by
  // `createdAt DESC, rowid DESC` and never trims a `pending` one. The legacy
  // `rowid` has no FeltDB counterpart, so it is reproduced by insertion order
  // rather than migrated as a fake identifier.
  const audit = (await state.collection('computer_audit').all()) as {
    dotId: string;
    outcome: string;
  }[];
  const perDot = new Map<string, { finished: number; pending: number }>();
  for (const row of audit) {
    const bucket = perDot.get(row.dotId) ?? { finished: 0, pending: 0 };
    if (row.outcome === 'pending') bucket.pending++;
    else bucket.finished++;
    perDot.set(row.dotId, bucket);
  }
  check(
    'retention:computer_audit finished rows within the window',
    [...perDot.values()].every((bucket) => bucket.finished <= AUDIT_RETENTION),
    `retention ${AUDIT_RETENTION}`,
  );
  const legacyPending = snapshot.audit.filter(
    (row) => row.outcome === 'pending',
  ).length;
  check(
    'retention:computer_audit pending rows never trimmed',
    [...perDot.values()].reduce((sum, bucket) => sum + bucket.pending, 0) ===
      legacyPending,
    `legacy ${legacyPending}`,
  );

  return { checks, ok: checks.every((entry) => entry.ok) };
}
