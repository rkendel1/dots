## Changelog

All notable changes to OpenDots are recorded here. This project follows
[semantic versioning](https://semver.org/).

## [0.2.0] — OpenDots on FeltDB

The release that makes FeltDB the declared, packaged durable-state authority of
the product.

### Added

- **`feltdb.flow`** — the authoritative application contract. Declares the
  `OpenDots` identity and all **18 runtime collections** with their real fields
  and `ref` relationships. Validated by the pinned FeltDB CLI
  (`node node_modules/@feltdb/core/bin/feltdb.js validate feltdb.flow`).
- **Contract drift protection** — `src/server/contract.ts` resolves the contract
  at startup, and `openFeltState()` refuses to start when the runtime uses a
  collection the contract does not declare. `feltdb.flow`, `RUNTIME_COLLECTIONS`
  and `MIGRATED_COLLECTIONS` are held equal by tests.
- **`opendots` CLI** — `start`, `status`, `stop` and `validate`, with no
  repository checkout, TypeScript toolchain or repository script required.
- **Distributable package** — `files`, `bin`, `main` and product metadata, plus a
  release gate that packs the tarball, installs it into a clean directory and
  drives the real product end to end.
- **Machine-readable compatibility** — `package.json#opendots` declares the
  product identity, the durable-state authority, and the compatible FeltDB
  version, so it can be read without inspecting source.

### Changed

- **FeltDB is the sole runtime durable-state authority.** Durable writes, restart
  persistence and lock ownership all go through FeltDB.
- **The collection namespace derives from the contract identity**
  (`loadContract().app.toLowerCase()`) instead of a repeated literal.
  `FELTDB_PATH` and `FELTDB_NAMESPACE` remain the supported environment
  configuration.
- **`@feltdb/core` is pinned to an exact version** (`0.11.9`) rather than a caret
  range, because the shipped contract is validated against that version's
  FlowSpec grammar.
- **The build copies `feltdb.flow` into `dist/`**, so the contract ships with the
  artifact and the container image. Previously the compiled server could not
  resolve its contract outside a source checkout.
- The container image sets `FELTDB_PATH` instead of the removed `DATABASE_PATH`.

### Fixed

- **The published artifact and container image could not start.** `feltdb.flow`
  was not included in `dist/`, so `contract.ts` raised _"feltdb.flow was not
  found"_ whenever OpenDots ran from a build rather than a checkout. The contract
  is now copied into `dist/` and covered by the release gate.
- **The published artifact served no UI.** The static routes were rooted at
  `./dist/client`, resolved against the process working directory. That happens to
  exist in a checkout, so the source-tree suites never saw it; started from an
  installed package in a user's own project, every route returned 404. The client
  directory is now located relative to the server module, and throws at startup if
  the bundle is missing rather than degrading to a blank page.

### Migration

- SQLite is retired from runtime. `data/opendots.sqlite` is **retained as a
  migration source only** and is never read at runtime. The migration tooling
  remains explicit and admin-only; it is not imported by startup and does not run
  as a side effect of tests.

### Added

- **OpenDots can now control real Compute executions.** A durable `executions`
  collection joins `feltdb.flow` (19 collections), an `ExecutionProvider`
  boundary isolates external work, and `ComputeExecutionProvider` speaks Compute's
  real `compute.remote@1` protocol — `POST /compute/jobs` for submission,
  `GET /compute/jobs/{id}` for status, `/result` for output, `/cancel` to stop.
  Nothing about that protocol is invented; see
  [`docs/EXECUTION-ARCHITECTURE.md`](docs/EXECUTION-ARCHITECTURE.md) for the
  routes, headers and status vocabulary OpenDots depends on.
- **Executions survive a restart.** State lives in FeltDB and is reconciled
  against the provider on startup. OpenDots never assumes an execution finished
  because the process restarted; it asks.
- **Starting an execution is safe to retry.** The durable record key is derived
  from the request's idempotency key, so a repeat — or two concurrent requests —
  converges on one execution instead of two. The same key is submitted to
  Compute, which resolves the retry to the job it already has.
- **Execution status has an enforced lifecycle.** `queued → starting → running →
completed`, with `failed` and `cancelled` reachable only from the states that
  allow them. Terminal states are final, and there is deliberately no API route
  that lets a client set one.
- **A Run action and execution visibility in the task detail view**, rendered
  entirely from `/api/executions`.
- `COMPUTE_ENDPOINT` and `COMPUTE_AUTHORIZATION` configure the provider. With no
  endpoint there is no provider, and OpenDots is fully usable without one —
  Compute is released independently, and this release does not wait for it.

### Known scope boundaries

- **Compute has no prompt input.** `compute.remote@1` accepts a workload
  artifact and nothing else, so OpenDots encodes a prompt as a small `shell`
  workload. What comes back is that workload's output, not a language-model
  answer. A prompt-shaped execution would require a Compute API that does not
  exist today, so it is not implemented.
- Receipts are stored verbatim inside the execution result but are not yet
  projected by a dedicated endpoint.
- Domain key schemes remain implementation-level TypeScript, because the installed
  FlowSpec format does not currently express record-key expressions.
- The Hono API is implemented by domain stores rather than generated from
  FlowSpec, because the format does not currently express service/API
  declarations.

### Not included

- **Chip integration is not part of this release.** It belongs to the
  Compute-configured execution path and is still being completed. OpenDots
  depends on Compute and never on Chip; the eventual execution environment may
  contain Chip, and OpenDots neither knows nor needs to. This release introduces no
  Chip or Compute dependency and can be followed by that integration without
  invalidating it.

## [0.1.0]

Initial template release.
