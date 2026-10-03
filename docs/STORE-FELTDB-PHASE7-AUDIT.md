# Phase 7 audit — SQLite retirement readiness

An audit of every remaining SQLite dependency in the repository, performed
**before** any code was changed. Phases 3–6 moved persistence onto FeltDB;
Phase 7 removes what is left and locks the result in with mechanical guards.

**Date of audit:** 2026-10-02

---

## Verdict

| Question                        | Answer                                                                     |
| ------------------------------- | -------------------------------------------------------------------------- |
| SQLite required for migration   | **YES**                                                                    |
| SQLite required at runtime      | **NO**                                                                     |
| SQLite required by tests        | **NO** (only the migration suite needs it, and it builds its own fixtures) |
| SQLite required by tooling      | **NO** (the migration CLI is administrative, not required to run the app)  |
| FeltDB authoritative at runtime | **YES**                                                                    |

The headline finding: **the runtime has no SQLite dependency to remove.** Phases
3–5 already did that work. What remains is configuration surface, documentation
and tooling that still _claim_ SQLite matters — plus no mechanical guard to stop
it creeping back.

---

## Method

```bash
rg -n 'node:sqlite|DatabaseSync|DATABASE_PATH|sqlite|\.sqlite|SQLITE|CREATE TABLE|SELECT |INSERT |UPDATE |DELETE |PRAGMA' \
  src tests scripts docs package.json
npm ls
```

Plus a trace of the startup path and a per-collection inventory of
`db.collection(...)` call sites.

## Findings by classification

### RUNTIME — none

Zero matches under `src/`. Specifically:

| Check                                        | `src/` count          |
| -------------------------------------------- | --------------------- |
| `node:sqlite` imports                        | **0**                 |
| `DatabaseSync` references                    | **0**                 |
| `DATABASE_PATH` references                   | **0**                 |
| `sqlite` / `.sqlite` (case-insensitive)      | **0**                 |
| `CREATE TABLE` / `PRAGMA`                    | **0**                 |
| `SELECT` / `INSERT ` / `UPDATE ` / `DELETE ` | **0** real statements |

Three `rg` hits under `src/` are the English word "Select" in two user-facing
strings and a client method named `select` — not SQL:

```
src/server/workspace-routes.ts:134  'Select a Dot and a conversation title.'
src/server/app.ts:115               'Select a conversation for this scheduled task.'
src/client/page-chat-requests.ts:5  select(scope: string) {
```

**Nothing in `src/` needs to be removed.** Section 7 of the PR ("Remove runtime
SQLite dependencies") is a no-op, and that is the correct outcome, not an
oversight.

### RUNTIME — package dependencies — none

`npm ls` shows **no SQLite package of any kind** in `dependencies` or
`devDependencies`. SQLite access was always `node:sqlite`, a Node 24 builtin, so
there is no dependency entry to drop. `@feltdb/core@0.11.9` is the only storage
dependency.

### RUNTIME — startup path — FeltDB only

```
node dist/server/server/index.js
  └─ openFeltState()                      src/server/index.ts:25
       └─ createFeltDB(...)               src/server/felt/state.ts:72,92   ← the only site
  └─ new Store(state.db)                  src/server/index.ts:27
  └─ new WorkspaceStore(owner, state.db)  src/server/index.ts:28
       └─ new ComputerStore(state, ...)   src/server/workspace.ts:51
       └─ new Pages(state, ...)           src/server/workspace.ts:57
  └─ workspace.bootstrap()                src/server/index.ts:34
  └─ Platform.create(...) / Runner / createApp(...)
```

`createFeltDB` appears in exactly one file (`src/server/felt/state.ts`), with two
call sites for the in-memory and local modes. No path opens
`data/opendots.sqlite`.

### RUNTIME — no fallback — confirmed

`openFeltState` releases the process lock and **rethrows** if the FeltDB runtime
fails to open (`src/server/felt/state.ts:164-172`). There is no `catch` that
substitutes another store, and no `try FeltDB → catch → SQLite` anywhere. A
failure to open FeltDB fails the process loudly.

### CONFIGURATION — `DATABASE_PATH` is stale (action required)

`.env.example:5`:

```
DATABASE_PATH=data/opendots.sqlite
```

This is **dead configuration**. No code reads `process.env.DATABASE_PATH`
anywhere. It is actively misleading: it tells an operator the runtime stores
state in that file, which is no longer true. The real variables are
`FELTDB_PATH` and `FELTDB_NAMESPACE` (`src/server/felt/state.ts:128,142`), and
neither appears in `.env.example`.

**Action:** replace the stale line with the FeltDB variables.

### MIGRATION — `migrations/` (retain)

| File                           | Role                                           |
| ------------------------------ | ---------------------------------------------- |
| `migrations/legacy-sqlite.ts`  | the **only** module that imports `node:sqlite` |
| `migrations/import-plan.ts`    | pure snapshot → canonical-record planner       |
| `migrations/apply-plan.ts`     | classify, conflict-detect, commit transactions |
| `migrations/verify.ts`         | independent post-migration verification        |
| `migrations/migrate.ts`        | CLI entry point                                |
| `migrations/inspect-legacy.ts` | read-only inspector for the source             |
| `migrations/inspect-target.ts` | read-only inspector for the target             |

All are outside `src/`, so `tsconfig.server.json` (which compiles from `src`
only) cannot reach them. `src/` never imports `migrations/` — verified statically
by `tests/runtime-sqlite-guard.test.ts`.

### TOOLING — `package.json`

| Script                           | Verdict                                     |
| -------------------------------- | ------------------------------------------- |
| `migrate:sqlite-to-felt`         | MIGRATION — explicit, administrative        |
| `migrate:sqlite-to-felt:dry-run` | MIGRATION — write-free                      |
| `inspect:sqlite`                 | MIGRATION — read-only source inspector      |
| `inspect:felt`                   | MIGRATION — read-only target inspector      |
| `dev` / `start` / `build`        | **RUNTIME — none of them invoke migration** |

There is no "if the store is empty, import SQLite" behaviour anywhere, and no
script aliases migration into startup.

### TEST FIXTURE — `tests/migrate-sqlite.test.ts`

The only SQLite consumer under `tests/`. It imports `node:sqlite` to build
throwaway legacy databases against the shipped schema. Legitimate: this is what
exercises the migration. It is excluded from the runtime guard by design.

### LEGACY DATA — `data/opendots.sqlite`

Present, and currently a **migration source** rather than a runtime dependency.
Audit of its contents:

| Table           | Rows |
| --------------- | ---- |
| `spaces`        | 1    |
| `dots`          | 1    |
| `dot_spaces`    | 1    |
| `settings`      | 1    |
| everything else | 0    |

It is needed as a migration fixture (it is the only real artifact of the legacy
schema) but it is **not** runtime state. Sidecars `opendots.sqlite-shm` /
`opendots.sqlite-wal` exist because the database is in WAL mode and even a
read-only connection creates them — see `docs/STORE-FELTDB-PHASE7.md` §WAL.

**Decision (PR §14): retain the file, document it as a legacy migration source,
and do not delete it in this PR.** Removal belongs in a separate cleanup change
once the migration tooling can reproduce its own fixtures independently.

### DOCUMENTATION — stale claims (action required)

`docs/SETUP.md` still tells operators SQLite is the live store. Four places:

| Line | Claim                                                                                    |
| ---- | ---------------------------------------------------------------------------------------- |
| 3    | "stores pages, Space and Dot configuration, and thread bindings in SQLite"               |
| 37   | `DATABASE_PATH` described as "SQLite file containing pages, workspace and work metadata" |
| 41   | "copying the SQLite file alone does not back up that history"                            |
| 53   | "Back up both storage layers: SQLite contains page content and thread bindings"          |

These are the most dangerous remaining references: not because they break
anything, but because an operator following them would back up the wrong file and
believe they were safe. **Action:** correct all four.

`docs/STORE-FELTDB-PHASE4.md` and `docs/EDGE-FELTDB-PHASE5.md` mention `CREATE
TABLE` / `PRAGMA` in historical narrative. Those are accurate descriptions of the
schema the migration came from, and are left as-is.

### DEAD CODE — `scripts/*.pl`

`scripts/fix-args.pl` and `scripts/fix-tests.pl` are one-shot codemods written
during the Phase 3→5 test rework ("add the `.store` hop"). They are not SQLite
related and are **out of scope for this PR** — but they are dead, already applied,
and re-running them would corrupt the tree. Flagged here for a separate cleanup
decision.

### A caveat about the naive grep

The pattern in the PR —

```bash
rg -n 'node:sqlite|DatabaseSync|DATABASE_PATH|CREATE TABLE|SELECT |INSERT |UPDATE |DELETE |PRAGMA' src/server
```

— returns **6 matches, not 0**, and all six are in comments:

```
src/server/store.ts:93        `INSERT OR IGNORE`: the defaults appear exactly when…
src/server/workspace.ts:104   SQLite's INSERT was create-only. FeltDB's insert() is an upsert…
src/server/workspace.ts:467   `ON CONFLICT(threadId) DO UPDATE SET value` with no lost update.
src/server/page-threads.ts:76 `INSERT OR IGNORE` — create-only on the pair…
src/server/page-threads.ts:115 `INSERT OR IGNORE` case, where their threadId stands…
src/server/page-threads.ts:182 SQLite's UPDATE on an absent row was a silent no-op.
```

These are exactly the comments that make the migration reviewable — each one
records the SQL semantics the FeltDB code replaced. Removing them to satisfy a
keyword grep would be the wrong trade.

**After comment and string-literal stripping, the count is 0.** That is the
number that matters, and `tests/runtime-sqlite-guard.test.ts` asserts it. The word
"SQLite" likewise appears 45 times under `src/server`, all in comments or strings;
the guard asserts 0 in executable code.

Two consequences for CI, both implemented:

1. The CI grep uses only identifiers that cannot appear in prose
   (`node:sqlite`, `DatabaseSync`, `DATABASE_PATH`, `CREATE TABLE`, `PRAGMA`) — it
   returns 0.
2. The comment-aware check lives in the test suite, where stripping comments is
   possible.

---

## Collection inventory

18 collections, enumerated from actual `db.collection(...)` call sites rather
than invented. Every one has both a runtime read and a runtime write path.

| #   | Collection             | Read site                      | Write site                                         | SQLite dep |
| --- | ---------------------- | ------------------------------ | -------------------------------------------------- | ---------- |
| 1   | `settings`             | `Store.settings`               | `Store.settings` (seed-once)                       | 0          |
| 2   | `spaces`               | `WorkspaceStore.spaces`        | `WorkspaceStore.bootstrap`                         | 0          |
| 3   | `dots`                 | `WorkspaceStore.dots`          | `WorkspaceStore.bootstrap`                         | 0          |
| 4   | `dot_space_grants`     | `toDot` membership             | grant create on Dot upsert                         | 0          |
| 5   | `pages`                | `Pages.get` / `Pages.list`     | `Pages.create` / `Pages.update`                    | 0          |
| 6   | `page_reviews`         | `Pages.reviewReceipt`          | `Pages.saveReview` (coupled with `pages`)          | 0          |
| 7   | `thread_bindings`      | `WorkspaceStore.conversations` | `WorkspaceStore.createConversation`                | 0          |
| 8   | `page_threads`         | `PageThreads.thread`           | `PageThreads.reserveThread` / `patch`              | 0          |
| 9   | `page_thread_ids`      | `PageThreads` thread guard     | `PageThreads.create` (coupled with `page_threads`) | 0          |
| 10  | `tasks`                | `Store.tasks` / `Store.detail` | `Store.createTask` / `claim`                       | 0          |
| 11  | `task_threads`         | `WorkspaceStore.taskThread`    | `WorkspaceStore.bindTaskThread`                    | 0          |
| 12  | `runs`                 | `Store.detail`                 | `Store.startRun` / `completeRun` / `fail`          | 0          |
| 13  | `task_events`          | `Store.detail`                 | `Store.event`                                      | 0          |
| 14  | `memories`             | `Store.memories`               | `Store.saveMemory` / `deleteMemory`                | 0          |
| 15  | `calls`                | `WorkspaceStore.calls`         | `WorkspaceStore.recordCall`                        | 0          |
| 16  | `captures`             | `WorkspaceStore.capture`       | `WorkspaceStore.setCapture`                        | 0          |
| 17  | `computer_permissions` | `ComputerStore.permissions`    | `ComputerStore.setPermissions`                     | 0          |
| 18  | `computer_audit`       | `ComputerStore.audit`          | `ComputerStore.record` / retention                 | 0          |

`tests/runtime-sqlite-guard.test.ts` re-derives this list from the source at test
time, so it cannot drift from reality.

---

## What Phase 7 changes

1. `docs/STORE-FELTDB-PHASE7-AUDIT.md` — this document.
2. `.env.example` — remove the dead `DATABASE_PATH`, document `FELTDB_PATH` /
   `FELTDB_NAMESPACE`.
3. `docs/SETUP.md` — correct four stale SQLite claims.
4. `tests/runtime-sqlite-guard.test.ts` — mechanical guard (0 SQLite in
   `src/server`), the static migration-boundary check, and the collection matrix.
5. `tests/runtime-cutover.test.ts` — acceptance tests A–E: starts and operates
   with SQLite absent, present-but-corrupt, and across process restarts.
6. `docs/STORE-FELTDB-PHASE7.md` — the cutover architecture, WAL behaviour and
   recovery procedure.

## What Phase 7 deliberately does not change

- **No runtime code.** `src/` is already correct; there is nothing to remove.
- **No migration code.** The Phase 6 guarantees stay exactly as they are.
- `data/opendots.sqlite` stays, as a documented legacy migration source.
- No new persistence layer, no caching, no mutex.
