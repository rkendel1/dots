# Phase 5 audit — remaining durable SQLite domains → FeltDB

Written from the actual implementation before any code changed. Companion to the
Phase 3 (`WorkspaceStore`) and Phase 4 (`Store`) migrations.

Everything FeltDB already owns is out of scope here: pages, page reviews,
spaces, dots, dot-space grants, thread bindings, settings, tasks, runs/leases,
task events, memories. What remains in SQLite is exactly five domains.

---

## 1. `page_threads` — `PageThreads` (`src/server/page-threads.ts`)

### Schema as it exists

```sql
CREATE TABLE IF NOT EXISTS page_threads(
  pageId     TEXT NOT NULL,
  dotId      TEXT NOT NULL,
  threadId   TEXT NOT NULL UNIQUE,
  ready      INTEGER NOT NULL DEFAULT 0,
  leaseUntil INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(pageId, dotId));
```

`leaseUntil` arrived via `ALTER TABLE`; the constructor still probes
`PRAGMA table_info` for it. No indexes beyond the primary key and the implicit
unique on `threadId`.

### Identity and relationships

The primary key is the composite `(pageId, dotId)`; `threadId` carries a second,
global uniqueness constraint. A page conversation is therefore reserved **per
(page, Dot) pair**, and one conversation can be anchored in only one page.

Relationships: `pageId → pages`, `dotId → dots`, `threadId → thread_bindings`
(resolved through the Intelligence provider). All three are foreign keys in
spirit only — SQLite never enforced them.

### Methods, callers, and semantics

| Method                                   | Caller                                       | Behaviour                                                 |
| ---------------------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| `thread(pageId, dotId)`                  | `Pages.thread` → `page-service.conversation` | `{threadId, ready}` or `undefined`                        |
| `reserveThread(pageId, dotId, threadId)` | `page-service.conversation`                  | two statements, returns whether the caller took the lease |
| `finishThread(pageId, dotId)`            | `page-service.conversation`                  | sets `ready = 1`                                          |
| `releaseThread(pageId, dotId)`           | `page-service.conversation`                  | clears the lease, only while `ready = 0`                  |
| `pageIdForThread(threadId)`              | `Pages.forThread`                            | the page a **ready** thread is anchored in                |

`reserveThread` is the interesting one. It is two independent autocommit
statements, not a transaction:

1. `INSERT OR IGNORE ... VALUES(?,?,?,0,0)` — create-only per `(pageId, dotId)`.
   The **first** `threadId` ever offered for a pair wins permanently; later
   callers' ids are discarded.
2. `UPDATE ... SET leaseUntil=now+60000 WHERE pageId=? AND dotId=? AND
ready=0 AND leaseUntil<=?`, returning `changes > 0`.

So the caller gets `true` only when it both finds the row unleased and not yet
ready. A ready row, or a row with an unexpired lease, yields `false` and the
caller raises a 409 "This page conversation is being created. Retry shortly."

The `UNIQUE(threadId)` constraint matters: if the offered `threadId` is already
taken by another pair, statement 1 inserts **nothing**, so statement 2 affects
zero rows and the caller gets `false`. That is a real, load-bearing branch.

### Ordering

None. Every read is by primary key or by the unique `threadId`. No sequence and
no timestamp ordering is exposed.

### Concurrency

---

## 2. `task_threads` — `WorkspaceStore.bindTask` / `taskThread`

### Schema as it exists

```sql
CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
```

`taskId` is the primary key. `threadId` is not unique, so a conversation can host
several tasks while a task can host only one conversation.

### Semantics

- `bindTask(taskId, threadId)` — `await requireThread(threadId)` (an ownership
  check), then a bare `INSERT`. Note this is **not** `INSERT OR IGNORE`: a second
  bind for the same task violates the primary key and raises SQLite's raw
  UNIQUE-constraint error.
- `taskThread(taskId)` — lookup, `string | undefined`.

Callers: `app.ts` binds right after `createTask`, and `index.ts`'s `Runner`
execute callback resolves the conversation for a claimed task. A task id is a
fresh UUID, so the duplicate path is unreachable through the HTTP surface.

### Ordering, concurrency, retention

None of any. Single-key reads and single-key creates; no expiry and no cleanup.

---

## 3. `calls` — `WorkspaceStore`

### Schema as it exists

```sql
CREATE TABLE IF NOT EXISTS calls(
  id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL,
  endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
-- plus ALTER TABLE ADD COLUMN anchorMessageId TEXT
```

### What a call is, and its lifecycle

A call is one voice session between the browser's WebRTC client and the voice
provider, owned by exactly one conversation thread. Identity is a `randomUUID`
generated in `createCall`; there is no externally supplied id. Status moves
`connecting → active → ended | failed`, and `endedAt` is stamped exactly when the
status becomes `ended` or `failed`.

### Methods and semantics

| Method                                   | Behaviour                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `calls(threadId?)`                       | `ORDER BY startedAt DESC`; filters by thread after an ownership check                                                               |
| `createCall(threadId)`                   | ownership check, then insert                                                                                                        |
| `call(id)`                               | lookup across all calls; throws `Call not found.` if absent; then ownership check on its thread                                     |
| `setCall(id, status, transcript, error)` | **no-ops when the call already has `endedAt`**; otherwise writes status/transcript/error and stamps `endedAt` for terminal statuses |
| `saveLateTranscript(id, transcript)`     | `UPDATE ... WHERE transcript='' AND endedAt IS NOT NULL`, returning `changes > 0` — a genuine compare-and-set                       |
| `anchorCall(id, anchor?)`                | unconditional write                                                                                                                 |
| `setCallError(id, error)`                | unconditional write                                                                                                                 |

`setCall`'s `endedAt` guard is what makes a call terminal-once: a late provider
callback cannot reopen a call that already ended.

### Ordering

`calls()` is ordered by `startedAt DESC` — global when no thread filter is
given, per-thread when filtered. There is no sequence column, so ties are
unordered in SQLite; `all()`'s insertion order plus a stable descending sort
reproduces the same guarantee Phase 4 established.

### Immutability

Mutable, and deliberately so: a call row is written at least three times
(`createCall`, `setCall`, then `anchorCall`/`setCallError`).

### Retry semantics

There is no retry. `saveLateTranscript` is the only conditional write, and its
boolean result tells the caller whether this attempt or an earlier one won.

---

## 4. `captures` — `WorkspaceStore`

### Schema as it exists

```sql
CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);
```

### Identity and relationship

---

## 5. `ComputerStore` (`src/server/computer-store.ts`)

Audited on its own, tracing schema → store → service → routes/tools → tests.

### Tables

```sql
CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS computer_audit(
  id TEXT PRIMARY KEY, dotId TEXT NOT NULL, action TEXT NOT NULL,
  actor TEXT NOT NULL, outcome TEXT NOT NULL, createdAt INTEGER NOT NULL);
```

**`computer_permissions`** — one row per Dot, a JSON blob of
`{enabled, browser, files, shell}`.

**`computer_audit`** — an append-mostly log with a `pending → succeeded | failed`
transition, a per-Dot retention cap, and a read cap.

### Methods and semantics

| Method                        | Behaviour                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `permissions(dotId)`          | parsed value, or `{enabled:false,browser:false,files:false,shell:false}` when absent |
| `patch(dotId, patch)`         | read-merge-write via `INSERT OR REPLACE`, returns the merged value                   |
| `begin(dotId, action, actor)` | fresh `randomUUID`, `outcome='pending'`, returns the receipt id                      |
| `finish(id, outcome)`         | sets the outcome, then applies retention                                             |
| `audit(dotId)`                | newest 50 by `createdAt DESC`                                                        |

`finish` performs **per-Dot retention**: it deletes every non-`pending` row for
that Dot that is not among the newest 1000 by `createdAt DESC, rowid DESC`.
Pending rows are never trimmed, so an in-flight action can never be deleted out
from under itself. `finish` on an unknown id is a no-op in both statements,
because the `dotId` subquery yields `NULL` and matches nothing.

### Callers

`ComputerService` only. `allowed()` reads `permissions` before every computer
action and re-checks it on a 50 ms interval during one, so a permission change
aborts work in flight. `audited()` wraps every owner- and agent-facing operation
in `begin`/`finish`, and `status()` reads both `permissions` and `audit` for the
panel. `computer-routes.ts` exposes them over HTTP; `computer-tools.ts` and
`DotAgent` reach them through `ComputerService`.

### What is **not** stored locally

---

## 6. The audit's twelve required answers

1. **Collections required** — `page_threads`, `page_thread_ids`, `task_threads`,
   `calls`, `captures`, `computer_permissions`, `computer_audit`.
2. **Record keys** — composite `(pageId, dotId)` for `page_threads`; `threadId`
   for the `page_thread_ids` uniqueness marker, `task_threads`, and `captures`;
   the call UUID for `calls`; the audit UUID for `computer_audit`; `dotId` for
   `computer_permissions`.
3. **Fields** — the SQLite column names verbatim, with `ready` becoming a real
   boolean, `value` blobs becoming structured records, and JSON text dropped.
4. **Indexes / query strategy** — none. Every read is a key lookup or a
   `filter` over `all()`; the page size is small and personal, so a scan is
   cheaper than maintaining the secondary indexes SQLite had.
5. **Domain version vs `__version`** — none of these five domains has a
   domain-level version field. `__version` is used **only** as a FeltDB fence and
   is stripped before any record crosses the application boundary.
6. **Transaction boundaries** — see §7.
7. **Concurrency** — see §8.
8. **Idempotency** — see §9.
9. **Ordering** — see §10.
10. **Restart persistence** — everything above survives restart; no domain has
    any startup repair step beyond the `page_threads` lease sweep that
    `reserveThread` performs on demand.
11. **Cross-domain atomic operations** — `call()` and `createCall()` read
    `thread_bindings` to authorise, then touch `calls`. SQLite did this as two
    independent reads and so does FeltDB; no cross-collection atomicity is
    introduced. The one genuinely new multi-record write is `reserveThread`,
    which must create the reservation and its `threadId` uniqueness marker
    together.
12. **Authoritative vs derived** — all seven collections are authoritative.
    Nothing here is demoted. Computer lifecycle and session state are not
    stored locally at all, so there is no derived-but-persisted record to
    reclassify.

---

## 7. Transaction boundaries

| Operation                               | SQLite today               | After                                                                                                                                                                                   |
| --------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reserveThread`                         | two autocommit statements  | create-only transaction (reservation + `threadId` marker), then a separate fenced lease transaction — the same two-step shape, because the create is genuinely independent of the lease |
| `finishThread`, `releaseThread`         | one conditional `UPDATE`   | one fenced transaction                                                                                                                                                                  |
| `bindTask`                              | one `INSERT`               | one create-only transaction                                                                                                                                                             |
| `createCall`                            | one `INSERT`               | one create-only transaction                                                                                                                                                             |
| `setCall`, `anchorCall`, `setCallError` | read then `UPDATE`         | read, evaluate, one fenced transaction                                                                                                                                                  |
| `saveLateTranscript`                    | conditional `UPDATE`       | read, re-evaluate the predicate, one fenced transaction                                                                                                                                 |
| `saveCapture`                           | one upsert                 | one fenced transaction                                                                                                                                                                  |
| `patch`                                 | read-merge-write           | read, merge, one fenced transaction                                                                                                                                                     |
| `begin`                                 | one `INSERT`               | one create-only transaction                                                                                                                                                             |
| `finish`                                | two unprotected statements | **one** transaction: the outcome update plus the retention trim, because the trim's `rowid DESC` cut-off must observe the just-written outcome                                          |

Every transaction id is unique per attempt, so FeltDB's replay protection can
never silently drop a mutation. No empty transaction is ever issued.

---

---

## 9. Idempotency and identity

- `page_threads` — create-only on `(pageId, dotId)`, exactly `INSERT OR IGNORE`.
  A create-only marker keyed by `threadId` preserves `UNIQUE(threadId)`: if the
  offered thread is already anchored, nothing is written and the caller is
  refused, which is precisely what SQLite's constraint did.
- `task_threads` — create-only on `taskId`.
- `calls` — the id is generated in `createCall` and written create-only.
- `captures` — upsert on `threadId`, as the SQLite `ON CONFLICT DO UPDATE` did.
- `computer_permissions` — upsert on `dotId`.
- `computer_audit` — the receipt id is generated in `begin` and written
  create-only.

The Phase 4 trap is respected throughout: **every** write passes its id
explicitly, because `put()`/`putIfAbsent()` otherwise generate one and overwrite
`data.id`. `putIfAbsent` also injects its own `id` into the stored record, so
every storage→domain conversion strips it alongside `__version` — `CallReceipt`
and `ComputerAudit` both carry a domain `id`, and only the injected copy is
removed.

---

## 10. Ordering

| Domain                  | Ordering                     | Mechanism after migration                   |
| ----------------------- | ---------------------------- | ------------------------------------------- |
| `page_threads`          | none                         | key lookups and one scan                    |
| `task_threads`          | none                         | key lookup                                  |
| `captures`              | none                         | key lookup                                  |
| `calls`                 | `startedAt DESC`             | stable descending sort over insertion order |
| `computer_audit` (read) | `createdAt DESC`             | stable descending sort over insertion order |
| `computer_audit` (trim) | `createdAt DESC, rowid DESC` | reverse insertion order, then stable sort   |

No global counter is introduced anywhere. The only `AUTOINCREMENT` in these five
domains was `computer_audit`'s implicit `rowid`, which existed solely as a
per-Dot tiebreak — replaced by insertion order, which is what it was.

---

## 11. Restart persistence

All seven collections are durable in `state.db`. There is no startup migration,
repair or recovery step in any of these domains, and none is added. Restart tests
close the durable handle — releasing the process lock — before reopening the
same path, because a file-backed `FeltState` owns that lock.

---

## 12. SQLite behaviour that cannot be reproduced exactly

Three deviations are deliberate and are the only ones:

1. **`bindTask` duplicate.** SQLite raised a raw UNIQUE-constraint error whose
   message is a driver implementation detail. FeltDB has no equivalent error
   type, so the duplicate is refused with a domain error. The observable
   behaviour — a second bind for one task is refused — is preserved; only the
   wording changes, and the wording was never part of the API.
2. **Ties in `ORDER BY startedAt DESC` / `createdAt DESC`.** SQLite left the
   order of equal keys unspecified. A stable sort over insertion order makes it
   deterministic and matches what Phase 4 already established for tasks and
   memories. This is a strict refinement, not a regression.
3. **`INSERT OR REPLACE` on `computer_permissions`** was a delete plus insert,
   which would have reset any rowid. That rowid was never read, so replacing it
   with a fenced upsert changes nothing observable.

Nothing else required reinterpretation.

---

## 13. SQLite intentionally remaining

After this phase the application reads and writes **no** SQLite at runtime. The
legacy schema for `page_threads`, `task_threads`, `calls`, `captures`,
`computer_permissions` and `computer_audit` is left declared and its data
untouched, purely as the Phase 6 import source. There is no dual-write path and
no fallback from FeltDB to SQLite.

---

## 14. Migration implications for Phase 6

`page_threads.ready`, `captures.value` and `computer_permissions.value` are
integers and JSON text in SQLite and become a boolean and structured records in
FeltDB. `page_threads` also needs its `threadId` uniqueness markers synthesised
during import, since a reservation and its marker become two records. The
`computer_audit` trim boundary should be recomputed on import rather than trusted
from the source, because the source's `rowid` tiebreak has no FeltDB equivalent
to carry across.

## 8. Concurrency strategy

FeltDB conditional transactions, never a local mutex and never a bare
read-modify-write:

- **`reserveThread`** — the lease is the only mutual exclusion in these domains.
  The conditional write is fenced on the reservation's version, so two concurrent
  callers for one `(page, Dot)` pair produce exactly one winner, and the loser
  re-reads and observes the held lease. This is the guarantee that
  `page-service.conversation` depends on for its 409.
- **`setCall` and friends** — last-write-wins as before, but a lost update is no
  longer possible: a stale writer is refused and retries against fresh state.
- **`saveLateTranscript`** — a true compare-and-set. The
  `transcript='' AND endedAt IS NOT NULL` predicate is re-evaluated on retry, so
  the boolean result still means "this call was the one that wrote the late
  transcript".
- **`patch`** — merge semantics are preserved; the fence only removes the window
  where two patches could interleave into a lost field.
- **`finish`** — outcome and trim commit together.
  There is no local record of a computer's lifecycle, control handback, browser
  profile, session, or credential. `status()`, `start()`, `stop()` and `control()`
  all read through to the OpenBot supervisor and computer service, and
  `endpoint()` re-derives the URL and validates the bot id and container name on
  every call. **No session or lifecycle state exists in OpenDots to migrate**, and
  nothing about Compute is touched.

### Optimistic concurrency and recovery

There is none today. `patch` is a plain read-merge-write with last-write-wins,
and `finish` is two unprotected statements. Migrating to FeltDB adds a version
fence to both, which preserves the observable merge behaviour while removing a
lost-update window; this is recorded as a deliberate strengthening, not a change
of semantics.

One capture per **thread**, upserted by `ON CONFLICT(threadId) DO UPDATE SET
value`. Related to `thread_bindings` through `threadId`; there is no link to
tasks or calls.

### Content versus metadata

`value` is the whole payload as JSON text — the captured page's `sample`, `text`,
`sources` and optional `screenshot`, written by the `read_public_page` tool and
read back through `GET /conversations/:id/capture`. There is no separate metadata
row and no binary column; the screenshot is a base64 string inside the JSON.

### Lifecycle and retention

Upsert-only. No delete, no expiry, no trimming. Reading a thread that has never
captured returns `null`.

### Authoritative, not derived

This is worth stating explicitly because it is the kind of record that looks
cacheable: the capture is written by a tool and read back verbatim, and nothing
re-derives it at read time. It is an authoritative record of what the agent
captured and is migrated as such — not demoted to a derived cache.

The lease is the only mutual exclusion here, and it was previously serialised by
SQLite's single-writer behaviour rather than by an explicit transaction. Two
concurrent `reserveThread` calls for the same pair must still produce exactly one
winner; that is reproduced with a conditional write fenced on the record version.

### Derived versus authoritative

Authoritative. A reservation is OpenDots' own record; Intelligence owns the
conversation body, never the reservation.
