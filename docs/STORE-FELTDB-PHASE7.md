# Phase 7 — FeltDB runtime cutover and SQLite retirement

OpenDots uses **FeltDB as its sole runtime persistence substrate.** There is no
second store, no fallback, and no hidden database.

```
                    ┌───────────────────────────────┐
                    │  OpenDots runtime             │
                    │  (src/server, src/client)     │
                    └───────────────┬───────────────┘
                                    │ reads · writes · retention · concurrency
                                    ▼
                    ┌───────────────────────────────┐
                    │  FeltDB (data/opendots-state) │  ← sole runtime authority
                    └───────────────────────────────┘

    data/opendots.sqlite
            │
            │  explicit, administrative, one-time
            ▼
      migrations/  ──▶  FeltDB
```

The legacy database is **input to a migration command**, never a participant in
the running application. Phases 3–5 removed the last runtime dependency; Phase 6
proved the data converts correctly; this phase locks the result in.

---

## The invariant

> **OpenDots runtime state authority = FeltDB.**

In concrete terms, all of the following are true and mechanically enforced:

| Concern              | Where it lives                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------- |
| application startup  | `src/server/index.ts` → `openFeltState()`                                                |
| store construction   | `Store`, `WorkspaceStore`, `Pages`, `ComputerStore` — all receive an open `StateFirstDB` |
| reads                | `db.collection(...)`                                                                     |
| writes               | `state.transaction(...)`                                                                 |
| queries and ordering | FeltDB collections plus the stable-sort helpers in `src/server/felt/records.ts`          |
| audit retention      | `ComputerStore`, per-Dot, in FeltDB                                                      |
| concurrency          | conditional transactions; losers retry on `PRECONDITION_FAILED`                          |
| restart recovery     | reopen `FELTDB_PATH`; the process lock guarantees a single writer                        |

**There is no fallback in any direction.** Specifically, none of these exist:

- FeltDB → SQLite fallback
- SQLite → FeltDB fallback
- `try` FeltDB, `catch` and use SQLite

A failure to open FeltDB **fails loudly**. `openFeltState` releases the process
lock and rethrows, and nothing above it substitutes a store, so the process exits
rather than serving against state it does not own.

---

## Configuration

| Variable           | Default               | Purpose                 |
| ------------------ | --------------------- | ----------------------- |
| `FELTDB_PATH`      | `data/opendots-state` | durable state directory |
| `FELTDB_NAMESPACE` | `opendots`            | collection namespace    |

`DATABASE_PATH` has been removed. It was dead configuration — nothing read it —
and leaving it in `.env.example` would have told operators the runtime still
stores state in a SQLite file.

## Migration is explicit and administrative

```bash
npm run migrate:sqlite-to-felt -- --dry-run   # validate, write nothing
npm run migrate:sqlite-to-felt                 # import, then verify
```

The migration is **never** run by `npm start`, `npm run dev`, `npm run build`, or
by application startup. There is deliberately **no** "if the store is empty,
import SQLite" behaviour: that would make SQLite an implicit runtime authority,
which is the exact thing this phase removes.

Migration code lives in `migrations/`, outside the runtime build's source root,
and no runtime module imports it. `tests/runtime-sqlite-guard.test.ts` asserts
both facts statically.

The Phase 6 guarantees are unchanged and still mandatory: idempotency, conflict
detection, transactional coupling of `page_threads` + `page_thread_ids`,
structured JSON, real booleans, legacy ordering, recomputed audit retention, and
an unmodified source.

---

## The legacy database

```
data/opendots.sqlite
    legacy migration source
    NOT runtime state
```

It is **retained**, not deleted. It is the only real artifact of the legacy
schema, and the migration tooling reads its shape. Deleting it is a separate
cleanup change, once the tooling can reproduce its own fixtures.

**The runtime does not care whether it exists.** Renaming, corrupting or deleting
it changes nothing about OpenDots's behaviour — which is what
`tests/runtime-cutover.test.ts` proves by running the runtime against an absent
file, a valid-but-foreign one, and five flavours of corrupt one.

### WAL sidecars

`data/opendots.sqlite` is in WAL mode, so a SQLite read creates two derived
files beside it:

```
opendots.sqlite
opendots.sqlite-shm     ← shared-memory index
opendots.sqlite-wal     ← write-ahead log
```

This happens even for a **read-only** connection, so running the migration once
leaves them on disk. They are not part of the authoritative data — the `.sqlite`
file plus a consistent WAL is — and **nothing in the runtime reads them**.

If the source must be checksummed, take the clean reading:

```bash
# Fold the WAL in first, then work from a copy.
sqlite3 data/opendots.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
cp data/opendots.sqlite /archive/opendots.sqlite
sha256sum /archive/opendots.sqlite
```

Migrating from the copy leaves the original directory untouched.
---

## Backups

Back up the **FeltDB state directory**, not the SQLite file:

- `FELTDB_PATH` (`data/opendots-state`) — pages, Spaces, Dots, tasks, memories,
  conversations, audit.
- The configured Intelligence project — conversation history.

`data/opendots.sqlite` is neither: after migration it is historical input.

---

## Guards

Nothing in the type system prevents a future `import { DatabaseSync } from
'node:sqlite'` in `src/server` — it would compile, lint and test cleanly. The
guards are therefore static source scans.

**`tests/runtime-sqlite-guard.test.ts`** asserts, over `src/server`:

- 0 `node:sqlite` imports
- 0 `DatabaseSync` references
- 0 `DATABASE_PATH` references
- 0 SQL statements (`CREATE TABLE`, `SELECT … FROM`, `INSERT INTO`,
  `UPDATE … SET`, `DELETE FROM`, `PRAGMA`)
- 0 mentions of "sqlite" at all, case-insensitively
- `createFeltDB` appears in exactly one file
- `openFeltState` is called from exactly one file
- the runtime opens exactly the 18 collections it owns
- those 18 match the migration's collection list exactly
- no runtime module imports `migrations/`
- `tsconfig.server.json` cannot reach `migrations/`
- no `dev`/`start`/`build` script invokes the migration
- `node:sqlite` appears in exactly two migration modules, both read-only tools

Comments and string literals are stripped before the SQL scan, so a module that
_documents_ what it replaced does not trip the guard.

**CI** runs the same `rg` over `src/server` as an explicit step, plus the runtime
acceptance tests with `data/opendots.sqlite` renamed out of the way, then
restores it and re-runs the migration suite.

## Acceptance tests

|     | Scenario                      | Covered by                                                                                          |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| A   | fresh FeltDB, SQLite absent   | `runtime-cutover` — starts, bootstraps, serves every domain                                         |
| B   | migrated state, SQLite absent | `runtime-cutover` — reads a previous process's writes                                               |
| C   | SQLite present                | `runtime-cutover` — operates normally, file untouched                                               |
| D   | SQLite corrupt                | `runtime-cutover` — random bytes, text, empty, truncated header, stale schema, and a directory path |
| E   | runtime writes                | `runtime-cutover` — create → restart → update → restart                                             |
| F   | migration                     | `migrate-sqlite` — full suite                                                                       |
| G   | migration rerun               | `migrate-sqlite` — 0 created, N already present, 0 errors                                           |
| H   | source preservation           | `migrate-sqlite` — byte-identical file                                                              |

---

## Running without SQLite

```bash
mv data/opendots.sqlite /tmp/opendots.sqlite.keep
npm run dev          # works normally
npm test             # everything except the migration suite
mv /tmp/opendots.sqlite.keep data/opendots.sqlite
```

`tests/migrate-sqlite.test.ts` is the only suite that needs the file, and it
builds its own throwaway fixtures — it is unaffected either way.

---

## Recovery

If the FeltDB state directory is lost, restore it from backup. If both are lost,
re-run the migration from the legacy database, which is why the source is kept
unmodified:

```bash
npm run migrate:sqlite-to-felt
```

If FeltDB cannot be opened at all, the process fails with the underlying error —
that is intentional. There is no degraded mode and no second store to fall back
to.

---

## Related

- [`STORE-FELTDB-PHASE7-AUDIT.md`](STORE-FELTDB-PHASE7-AUDIT.md) — the audit
  that preceded this phase, and what it found.
- [`STORE-FELTDB-PHASE6.md`](STORE-FELTDB-PHASE6.md) — how legacy data is
  converted, and every guarantee the migration makes.
- [`SETUP.md`](SETUP.md) — running the app.
