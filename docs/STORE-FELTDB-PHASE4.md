# Phase 4 audit — Store SQLite → FeltDB

Written from the actual implementation before any code changed. Companion to the
Phase 3 migration of `WorkspaceStore`.

## 1. SQLite tables `Store` owns

All five come from the single `CREATE TABLE` block in `src/server/store.ts`.
`Store` owns nothing else, and owns all five.

| Table      | Purpose                       | Notable column semantics                                                             |
| ---------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `settings` | singleton app settings        | `id INTEGER PRIMARY KEY CHECK(id=1)`, `value` = JSON blob, seeded `INSERT OR IGNORE` |
| `tasks`    | task lifecycle                | `status`, `intervalSeconds`, `nextRunAt`, `error`, **`lease`**, **`leaseUntil`**     |
| `runs`     | one row per execution attempt | `id` **is** the lease UUID                                                           |
| `events`   | task event log                | `id INTEGER PRIMARY KEY AUTOINCREMENT`, read `WHERE taskId=? ORDER BY id`            |
| `memories` | stored user memories          | upsert on `id`, updates `text` only                                                  |

Indexes `tasks_due`, `runs_task`, `events_task` exist only for the reads below.

## 2. Store API and callers

18 public methods. Names and argument shapes are preserved; only `constructor`
and `close()` change shape (see the report).

| Method                                 | Current return        | Caller sites                                                                 |
| -------------------------------------- | --------------------- | ---------------------------------------------------------------------------- |
| `settings()`                           | `Settings`            | `app.ts` ×4, `runner.ts`, `platform.ts` ×2, `voice.ts` ×3, `dot-agent.ts` ×4 |
| `updateSettings(patch)`                | `Settings`            | `app.ts`                                                                     |
| `tasks()`                              | `Task[]`              | `app.ts`, `runner.ts`                                                        |
| `task(id)`                             | `Task \| undefined`   | internal only                                                                |
| `createTask(prompt, intervalSeconds?)` | `Task`                | `app.ts`                                                                     |
| `detail(id)`                           | `Detail \| undefined` | `app.ts`                                                                     |
| `event(taskId, runId, text)`           | `void`                | `runner.ts` (progress), internal                                             |
| `action(id, action)`                   | `Task \| undefined`   | `app.ts`                                                                     |
| `schedule(id, intervalSeconds)`        | `Task \| undefined`   | `app.ts`                                                                     |
| `claim(now?)`                          | `Claim \| null`       | `runner.ts`                                                                  |
| `owns(claim)`                          | `boolean`             | `runner.ts` (100 ms poll + progress)                                         |
| `finish(claim, result, now?)`          | `boolean`             | `runner.ts`                                                                  |
| `release(claim, reason)`               | `void`                | `runner.ts` (`stop()`)                                                       |
| `fail(claim, error)`                   | `void`                | `runner.ts`                                                                  |
| `memories()`                           | `Memory[]`            | `app.ts`, `runner.ts`, `dot-agent.ts`                                        |
| `saveMemory(text, id?)`                | `Memory`              | `app.ts` ×2                                                                  |
| `deleteMemory(id)`                     | `boolean`             | `app.ts`                                                                     |
| `close()`                              | `void`                | `index.ts` (shutdown), tests                                                 |

`Platform`, `VoiceService`, `ComputerService` and `DotAgent` reach the store
through `this.platform.store` / `this.store`.

## 3. Existing semantics that must be preserved

**Ordering.** `tasks()` and `memories()` are `ORDER BY createdAt DESC`.
`detail()` reads runs `ORDER BY startedAt DESC, rowid DESC` and events
`ORDER BY id`. FeltDB's `all()` returns insertion (rowid) order — verified, and
verified to survive a restart — so each SQL ordering is reproduced by a _stable_
sort over that insertion order: a descending sort keeps rowid ascending for
ties, and the run query reverses insertion first so ties come back
rowid-descending.

**Settings.** Singleton; defaults `{name:'Dot', paused:false,
researchAllowed:true, memoryAllowed:true}`. `updateSettings` merges a patch and,
when the change newly sets `paused`, or clears `researchAllowed`, or clears
`memoryAllowed`, invalidates **every** running task to `queued` with
`'Run stopped because settings changed.'` There are no secrets in this record;
API keys live in `process.env` via `PlatformConfig` and stay there.

**Task creation.** Queued, with `nextRunAt/error/lease/leaseUntil` null, plus a
`'Task added to the research queue.'` event.

**Leasing.** `claim(now)`:

1. returns `null` if settings are paused or research is disallowed;
2. invalidates every `running` task with `leaseUntil <= now` to `queued` with
   `'Previous worker lease expired; safely retrying.'`;
3. picks the oldest (`ORDER BY createdAt LIMIT 1`) `queued` task, or a
   `completed` task whose `nextRunAt <= now`;
4. stamps `lease = randomUUID()`, `status='running'`, `leaseUntil = now+180_000`,
   clears `nextRunAt`/`error`, inserts a `running` run whose **id is the lease**,
   and logs `'Research worker started.'`

There is **no renewal method** and none is added: the fixed 180 s lease pairs
with Runner's 100 ms `owns()` poll and 90 s run timeout.

**Ownership and cancellation.** `owns(claim)` is `status==='running' &&
lease===claim.lease`. `finish`, `fail` and `release` all re-check it _inside the
transaction_, which is what stops a late worker overwriting a cancellation.
`finish` additionally returns `false` — having written nothing.

**Repeats.** `finish` sets `nextRunAt = now + intervalSeconds*1000` when the task
has an interval, else null. `schedule` recomputes `nextRunAt` only when the task
is currently `completed`.

**Events.** Append-only: one of `'Research worker started.'`, `'Fictional sample
brief ready.'` / `'Research brief ready.'`, `'Task queued for a new run.'`,
`'Task paused.'`, `'Task cancelled.'`, `'Run stopped because settings changed.'`,
`'Previous worker lease expired; safely retrying.'`, or a schedule note.

**Memories.** `saveMemory` is upsert-on-`id` updating `text` only, so an existing
memory keeps its `createdAt`. `deleteMemory` returns whether a row was deleted.

## 4. Transaction boundaries and concurrency assumptions

`this.transaction()` is `BEGIN IMMEDIATE`, serialising all writers in-process.
It wraps exactly six operations: `updateSettings`, `action`, `claim`, `finish`,
`release`, `fail`. `createTask` and `schedule` were **not** atomic in SQLite —
the task write and the event write were separate statements.

The correctness `BEGIN IMMEDIATE` provided is not optional: `owns()` is a
read-then-write and is only safe because it runs inside the write lock. FeltDB
has no such lock, so each of those six becomes a conditional transaction fenced
on the `__version` it read. That is strictly stronger than the original, and it
holds across processes too.

## 5. How Runner depends on Store

`tick()` claims work, polls `owns()` every 100 ms, reads `settings()` and
`memories()`, writes progress through `event()`, then calls `finish()` or
`fail()`. `stop()` reads `tasks()` and `release()`s what it still owns.
`progress` is handed to `research()` as a synchronous `(text: string) => void`.

Runner is **not** redesigned. Only the awaits change, plus `progress` becoming
`Promise<void>` so event ordering survives, and `stop()` becoming awaitable so
its releases are not abandoned.

## 6. Derived versus authoritative

Authoritative: task `status`/`lease`/`leaseUntil`, the run row, the settings
record, every event, every memory. Derived and therefore **not** stored:
`owns()` (a comparison), and the `events.id` counter — which existed in SQLite
only because `INTEGER PRIMARY KEY AUTOINCREMENT` was the cheapest way to order

## 8. Proposed FeltDB collections

`Store` receives `state.db`; it neither constructs nor closes FeltDB.

- **`settings`** — one record at fixed key `settings`. Fields `name`, `paused`,
  `researchAllowed`, `memoryAllowed`, `__version`.
- **`tasks`** — key = task id. Field names match the columns exactly, plus
  `__version`.
- **`runs`** — key = lease (the SQLite `runs.id`). Adds `__version`; `result`
  holds the object rather than JSON text.
- **`task_events`** — key = `${taskId}.${seq}`, `seq` a zero-padded per-task
  sequence. Only _per-task_ ordering is ever read, so a per-task sequence is the
  faithful and minimal replacement; no global counter is introduced. `seq` is
  exposed as the existing numeric `TaskEvent.id`.
- **`memories`** — key = memory id.

No redundant derived state is stored. `__version` is storage bookkeeping and is
stripped before any record crosses the application boundary.

## 9. Concurrency strategy

Read the record, evaluate the domain rule, then commit with `expectedVersion`
fences on everything that was read.

- **Competing claims** — two workers reading the same queued task both fence on
  its version; exactly one commits (verified: 1 of 6 concurrent conditional
  writes wins, the rest get `PRECONDITION_FAILED`). The loser retries and either
  takes a different task or returns `null` — exactly what `BEGIN IMMEDIATE`
  produced.
- **Cancellation versus late result** — `finish`/`fail`/`release` fence on the
  task version _and_ re-check `status==='running' && lease===claim.lease`. A
  cancel bumps the version, so the late result is refused and `finish` still
  returns `false`.
- **Expired lease recovery** — unchanged; `claim()` sweeps and invalidates.
- **Transaction ids** are unique per attempt. Reusing one silently applies
  nothing (re-verified this phase).

### FeltDB behaviours verified before relying on them

| Finding                                                                                                                            | Consequence                                               |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `put(data)` without an explicit id generates a synthetic key **and overwrites `data.id`**                                          | always pass the id                                        |
| staged `set()` with `expectedVersion` is enforced and the authority assigns the next version itself                                | fences are reliable; omitting `__version` is safe         |
| a failed guard leaves **every** other staged operation unwritten                                                                   | rollback is real                                          |
| an empty transaction, or one that only stages `require()`, is refused                                                              | never issue one                                           |
| `conditionalRefusal()` returns `{conflict:false}` for an embedded `ConditionalConflictError` (it only reads `feltdbCode`/`status`) | detect conflicts via `instanceof`/`code`, not that helper |
| `delete()` on a missing key throws on the file runtime but is silent in memory                                                     | `deleteMemory` checks existence first                     |
| `all()` preserves insertion order, including across restart                                                                        | ordering is reproducible                                  |
| transaction operation ids reject `:` but accept `[A-Za-z0-9._-]`                                                                   | composite keys use `.`                                    |

## 10. SQLite intentionally remaining after this phase

`page_threads` (`PageThreads`), `task_threads`, `calls` and `captures`
(`WorkspaceStore`), and all of `ComputerStore`'s tables. None are touched here.

## 11. Migration implications for Phase 6

No importer, no dual write, no SQLite read fallback, and the SQLite file is not
deleted. Existing `settings`, `tasks`, `runs`, `events` and `memories` rows are
**not** readable after this phase, so Phase 6 must import them before any
production cutover. Three importer details are already pinned down:
`runs.result` becomes structured rather than JSON text; `events.id` becomes a
per-task sequence; and `memories` must preserve `createdAt` on the text-only
update path.
an append-only log. `Run.result` is stored structured rather than as JSON text.

## 7. Existing tests

`tests/store.test.ts` covers restart persistence (file path, reopen, expired
file lock), expired-lease recovery (requeues and yields a _new_ lease),
competing lease acquisition (exactly one lease), and `finish()` returning
`false` on a stale claim. `tests/runner.test.ts` covers
abort-on-permission-revocation, memory-permission gating, and
graceful-shutdown requeue. `tests/app.test.ts` covers the HTTP surface. No test
asserts a specific event `id`.
