# Phase 6 — SQLite → FeltDB data migration

Phase 6 migrates historical SQLite data into FeltDB. **SQLite is not restored as
a runtime persistence mechanism.**

Phases 1–5 moved OpenDots' persistence onto FeltDB and left `src/` free of any
SQLite dependency. This phase does the remaining half of that work: reading the
existing legacy database once, converting its rows to the canonical record shapes
the runtime already uses, and writing them into the FeltDB collections — without
ever writing back to the source.

```
data/opendots.sqlite          FeltDB (data/opendots-state)
      │                                ▲
      │ read-only                      │ transactions, create-only
      ▼                                │
migrations/legacy-sqlite.ts ──▶ import-plan.ts ──▶ apply-plan.ts ──▶ verify.ts
```

---

## Source

|         |                                                           |
| ------- | --------------------------------------------------------- |
| Path    | `data/opendots.sqlite`                                    |
| Opened  | `new DatabaseSync(path, { readOnly: true })`              |
| Written | never — not updated, altered, vacuumed, marked or deleted |

`migrations/legacy-sqlite.ts` is the **only** file in the repository that imports
`node:sqlite`. It lives outside `src/`, so the runtime server build cannot reach
it. Every read is explicitly ordered, so the import is deterministic.

The legacy file can be archived once migration verification passes. Keep it until
then: it is the only copy of the historical data.

## Target collections

All eighteen collections the runtime owns are covered, using the schemas and
serialization conventions from `src/server/felt/records.ts`,
`src/server/store-collections.ts`, `src/server/workspace-collections.ts`,
`src/server/computer-collections.ts`, `src/server/pages.ts` and
`src/server/computer-store.ts`. There is no second schema definition for
migration: keys and record shapes are imported from those modules, so a key scheme
can never drift between the importer and the runtime.

| Legacy table           | Collection             | Key                                 |
| ---------------------- | ---------------------- | ----------------------------------- |
| `settings`             | `settings`             | `SETTINGS_KEY`                      |
| `spaces`               | `spaces`               | `id`                                |
| `dots`                 | `dots`                 | `id`                                |
| `dot_spaces`           | `dot_space_grants`     | `grantKey(dotId, spaceId)`          |
| `pages`                | `pages`                | `id`                                |
| `page_reviews`         | `page_reviews`         | `reviewKey(threadId, toolCallId)`   |
| `thread_bindings`      | `thread_bindings`      | `id`                                |
| `page_threads`         | `page_threads`         | `pageThreadKey(pageId, dotId)`      |
| — (synthesized)        | `page_thread_ids`      | `threadId`                          |
| `tasks`                | `tasks`                | `id`                                |
| `task_threads`         | `task_threads`         | `taskId`                            |
| `runs`                 | `runs`                 | `id` (the lease UUID, as in SQLite) |
| `events`               | `task_events`          | `eventKey(taskId, seq)`             |
| `memories`             | `memories`             | `id`                                |
| `calls`                | `calls`                | `id`                                |
| `captures`             | `captures`             | `threadId`                          |
| `computer_permissions` | `computer_permissions` | `dotId`                             |
| `computer_audit`       | `computer_audit`       | `id`                                |

Existing identifiers survive the migration unchanged: page ids, Dot ids, thread
ids, task ids, call ids, capture keys, permission keys, audit ids, every
timestamp and every cross-domain reference.

## Transformations

### `ready`: integer → boolean

SQLite stored booleans as `0`/`1`. `toBoolean` accepts **only** those two values:

| Source        | Target                                           |
| ------------- | ------------------------------------------------ |
| `0`           | `false`                                          |
| `1`           | `true`                                           |
| anything else | migration error naming the collection and record |

No truthiness coercion happens anywhere: a legacy `ready = 2` would have been
truthy, which is exactly the silent corruption the strict check prevents. The same
rule applies to `dots.researchAllowed`, `dots.memoryAllowed` and
`dots.skillDeliveryEnabled`.

The report lists `ready values converted` (the `page_threads.ready` count)
separately from `boolean values converted` (the total across every domain), so
one figure is answerable without knowing the other.

### JSON text → structured values

`captures.value`, `computer_permissions.value` and `runs.result` were JSON text in
SQLite and are structured documents in FeltDB. `parseJson` round-trips objects,
arrays, strings, numbers, booleans, `null` and nested combinations exactly.
Malformed JSON is a **failure**, not a silent fallback to the raw string — a
string here would be indistinguishable downstream from a legitimately
string-shaped capture. Values are never double-encoded. Every error names the
collection and the record id.

`computer_permissions` additionally requires `enabled`, `browser`, `files` and
`shell` to be real booleans, and `runs.result` is left `null` when the source
column was `NULL` rather than becoming an empty document.

### `events.id` → per-task `seq`

`events.id` was a global `AUTOINCREMENT` counter, but the only read was
`WHERE taskId = ? ORDER BY id`, so the gaps between two tasks were never
observable — only the order _within_ a task was. `assignEventSeq` renumbers each
task's events `0, 1, 2 …` in legacy `id` order, which is what `Store.nextEventSeq`
would have produced. No global counter is invented, because there is no global
ordering to preserve.

### Synthesized page-thread markers

`page_thread_ids` did not exist in SQLite. It is the durable half of the legacy
`UNIQUE(threadId)` constraint, and it is created for every imported
`page_threads` row, keyed by the bare `threadId` — exactly what
`PageThreads.anchor` writes.

A conversation may be anchored to at most one page. If the legacy data contains
two `page_threads` rows with the same `threadId` and different `pageId`s, the
migration **fails** and reports the `threadId` and both conflicting reservation
keys. No winner is chosen, because picking one would silently lose a reservation.

### Audit retention

`computer_audit` is the one domain whose ordering depended on SQLite's `rowid`,
which has no FeltDB equivalent. `rowid` is **not** migrated as though it were a
durable application identifier; it is reproduced through insertion order.

The importer reads audit rows in legacy `rowid` order and writes them in that
order, so insertion order _is_ the `rowid` order. It then recomputes the trim
boundary with the same policy `ComputerStore.finish` applies at runtime:

- per Dot, take the finished rows (any `outcome` other than `pending`);
- order them by `createdAt DESC`, breaking ties by insertion order — which is
  exactly the legacy `createdAt DESC, rowid DESC`;
- keep the newest `AUDIT_RETENTION` (`1000`) and trim the rest;
- never trim a `pending` row, however old it is.

Trimmed rows are reported (`audit records trimmed`, plus their ids) and are
asserted to be absent from the target during verification.

## Transactions

Writes are staged into FeltDB transactions, batched at 50 records by default.
Batches are built from **whole coupled groups**, never from a flat list: a
reservation and its thread marker are one logical record, and a batch boundary
between them would commit half of a pair. A group larger than the batch size
still lands in a single transaction — correctness of the invariant outranks the
transaction size limit.

Each write uses `requireAbsent`, so a migrated record can never be silently
overwritten.

There is no global mutable migration state. The planner is a pure function of the
snapshot, which is what lets `--dry-run` and the real run share one validation
path.

## Idempotency

Every planned write is a create, and every record is classified **before** the
first write:

| Target state                   | Action                     |
| ------------------------------ | -------------------------- |
| key absent                     | create                     |
| key present, identical content | skip — already migrated    |
| key present, different content | **conflict** — fail loudly |

A conflict aborts the whole migration before the first write, so the target is
either fully migrated or untouched. Migrated data is never overwritten.

A conflict is detected by `sameContent`, which compares structurally and ignores
two FeltDB-owned fields: `__version` (the storage fence) and the `id` FeltDB
injects from the record key. The injected `id` is only ignored for records whose
domain shape has no `id` of its own — a Dot, a call or a page genuinely owns one,
and it is still compared, so a changed identity cannot pass as "already
migrated".

A partially completed prior run simply resumes: whatever landed is skipped, the
rest is created, and the result verifies. `requireAbsent` also means a lost race
refuses the write instead of clobbering it.

## Dry run

```bash
npm run migrate:sqlite-to-felt -- --dry-run
```

A dry run opens the SQLite source read-only, inspects every record, parses and
validates every conversion, detects conflicts, calculates the expected counts and
the expected audit trim — and performs **no** FeltDB writes. It does open the
target, because reporting conflicts and idempotency against real state requires
reading it.

The real run uses the same planner and the same validation logic; only the write
step is skipped.

## Execution

```bash
# 1. Preview. Writes nothing.
npm run migrate:sqlite-to-felt -- --dry-run

# 2. Import, then verify. Exits non-zero on any problem.
npm run migrate:sqlite-to-felt

# 3. Optional: non-default paths.
npm run migrate:sqlite-to-felt -- --source path/to/legacy.sqlite --state path/to/state
```

The migration is an explicit operation. Nothing in the application startup path
calls it, and starting the server never migrates anything.

### Report

```
OpenDots SQLite → FeltDB migration
settings:                  1
spaces:                    1
dots:                      1
dot_space_grants:          1
pages:                     0
page_reviews:              0
thread_bindings:           0
page_threads:              0
page_thread_ids:           0
tasks:                     0
task_threads:              0
runs:                      0
task_events:               0
memories:                  0
calls:                     0
captures:                  0
computer_permissions:      0
computer_audit:            0
JSON values parsed:        1
ready values converted:    0
boolean values converted:  3
audit records imported:    0
audit records retained:    0
audit records trimmed:     0
records created:           4
records already present:   0
conflicts:                 0
errors:                    0
migration: COMPLETE
```

That is the actual output of running the migration against the real
`data/opendots.sqlite`, which contains one settings row, one Space, one Dot and
one Dot/Space grant. Every Phase 5 collection is empty in the source, which is
why the dedicated test suite builds synthetic databases instead of relying on it.

The per-collection counts are the source-to-target figures, so they can be
checked directly against SQLite. The only intentional differences are the
synthesized `page_thread_ids` and the trimmed audit rows, both reported
separately.

## Validation

After a real migration, `migrations/verify.ts` re-reads the finished state and
checks it **against the source snapshot, not against the plan** — it re-derives
what was written from the data itself, using its own structural comparison so a
bug in the planner's comparator cannot cancel itself out on both sides.

- **Counts** — every collection, accounting only for synthesized markers and
  trimmed audit rows.
- **Identity and content** — every source record exists at exactly the key the
  runtime would use, and its whole domain record matches field for field.
- **Relationships** — only references the schema genuinely models:
  `dots → spaces`, `dot_space_grants → dots/spaces`, `pages → spaces/pages`,
  `page_reviews → pages/spaces`, `page_threads → pages/dots/page_thread_ids`,
  `thread_bindings → dots`, `task_threads → tasks`, `runs → tasks`,
  `task_events → tasks/runs`, `calls → threads`, `captures → threads`,
  `computer_permissions → dots`, `computer_audit → dots`. A Dot's `spaceId` is
  its default page destination, not a membership edge — membership lives in
  `dot_space_grants` — so it is checked as the Space reference it is, and no
  foreign key is invented where the code has none.
- **JSON** — deep equality on every parsed column.
- **Booleans** — checked as _types_ as well as values, so a coerced `2` could not
  pass.
- **Ordering** — the runtime's stable-sort semantics are re-applied and compared
  against the legacy expectation for calls, per-task run lists, task events, and
  the newest-first task/memory/audit lists.
- **Retention** — the finished-row window is within `AUDIT_RETENTION` per Dot,
  and every `pending` row survived.
- **Restart persistence** — a dedicated test closes the state, reopens the same
  path, and re-runs the whole verification suite against the reopened database.

Any failed check is printed and sets the exit code to 1, so the migration reports
`INCOMPLETE`.

## Rollback and recovery

**The legacy file is never modified**, so the safest recovery is to discard the
target and start over:

```bash
rm -rf data/opendots-state          # drop the FeltDB target
npm run migrate:sqlite-to-felt      # re-import from the untouched source
```

Because the migration is idempotent, an interrupted run also resumes on its own:
re-run the same command. Already-imported records are skipped after an equality
check, and the remainder is created.

If a conflict is reported, the target was **not** written for that run. Decide
which value is correct — the legacy source or the existing target record — and
then either correct the source and re-run, or delete the specific conflicting
target record and re-run. The importer will never overwrite for you.

Because no legacy data is destroyed, SQLite is the authority until the migration
has been verified; it can be archived afterwards.

## Tests

`tests/migrate-sqlite.test.ts` builds throwaway legacy databases against the real
shipped schema and covers: basic migration, empty source, boolean conversion
(including rejection of out-of-range values), JSON conversion for every shape,
page-thread marker synthesis and identity, duplicate-thread conflict,
transaction atomicity, idempotency (rerun, already-present marker, changed target,
partially completed prior run), audit trimming and its boundary, event
sequencing, ordering, restart persistence, and that the SQLite file stays
byte-identical.

The real database is empty for every Phase 5 collection, so these synthetic
fixtures are what actually exercise the conversions. They supplement — and do not
replace — running the migration against the real file.

## Guardrails

The runtime stays SQLite-free. `src/` contains no `node:sqlite`, no
`DatabaseSync`, no SQL and no `DATABASE_PATH`. Migration-only SQLite access lives
in `migrations/`, outside the runtime build's source root, and the guard is not
weakened to permit SQLite imports throughout `src`.

**SQLite may exist as a historical migration source. It is not an OpenDots
runtime dependency.**
