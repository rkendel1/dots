# Phase 8 — the authoritative `feltdb.flow` contract

Phase 7 made FeltDB the sole runtime durable-state authority and proved it with
tests. It did not say _where the model of OpenDots' durable state lives_. That was
implicit, spread across `store.ts`, `store-collections.ts`, `computer-store.ts`,
`page-threads.ts` and `workspace.ts`.

This phase gives the model a single authoritative declaration and makes the
runtime consume it.

```
feltdb.flow                 the declaration (application identity + collections)
        │
        ▼
src/server/contract.ts      the runtime's view of it
        │
        ▼
openFeltState()             refuses to start on an undeclared collection
        │
        ▼
domain stores               Store / WorkspaceStore / ComputerStore / PageThreads
        │
        ▼
FeltDB
```

## The contract

[`feltdb.flow`](../feltdb.flow) declares the application and all 20 runtime
collections, with real fields and real `ref` relationships:

```
flow_version 1

app OpenDots {
  collection pages {
    id: text
    spaceId: ref spaces
    parentId: ref pages
    title: text
    ...
  }
}
```

It is written in FeltDB's FlowSpec syntax — the one the **installed
`@feltdb/core@0.11.9`** parses. Nothing about it is invented:

| Element     | Where it came from                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| grammar     | `formatFlowSpec()` / `parseFlowSpec()` in `dist/flowspec.js`                                              |
| field types | `FLOW_PRIMITIVE_TYPES`, plus `ref` and `enum(...)` from `isValidFlowFieldType()`                          |
| field names | the runtime record types in `workspace-collections.ts`, `store-collections.ts`, `computer-collections.ts` |
| collections | `MIGRATED_COLLECTIONS` in `migrations/import-plan.ts` — derived, not remembered                           |

### Validated by the real tooling

```
$ node node_modules/@feltdb/core/bin/feltdb.js validate feltdb.flow
✓ OpenDots: 20 collections, 0 capabilities, 0 workflows, 0 agents
```

CI runs exactly this. It invokes the pinned binary by path rather than `npx
feltdb`, because `npx` can resolve a _globally installed_ FeltDB CLI of a
different version, which would validate against a grammar this repository has not
pinned. That is not hypothetical: a global `@feltdb/cli@0.4.3` is installed on
the development machine.

### Key-scheme ownership

The boundary follows the installed format's limits:

```
feltdb.flow   →  collection identity, fields, relationships
TypeScript    →  deterministic record keys
```

A `FlowCollection` declares `fields` and `indexes`; `flowSpecToManifest()` emits
`{ name, fields }`, and no record-key expression exists anywhere in FlowSpec.
Writing a `key` keyword the installed CLI cannot parse would produce a contract it
rejects, so the keys stay in TypeScript where they have always lived and where
each has exactly one implementation:

| Function        | Record key of      | Composed from               |
| --------------- | ------------------ | --------------------------- |
| `pageThreadKey` | `page_threads`     | `pageId`, `dotId`           |
| `grantKey`      | `dot_space_grants` | `dotId`, `spaceId`          |
| `eventKey`      | `task_events`      | `taskId`, `seq`             |
| `reviewKey`     | `page_reviews`     | `threadId`, `toolCallId` \* |

\* `reviewKey` is the one scheme not composed of stored fields. It names the
conversation review the receipt belongs to, so a retried tool call replays
instead of creating a second page. What the contract declares is the payload it
resolves to — `pageId` and `spaceId`.

`tests/contract-feltdb-flow.test.ts` imports the real key functions and asserts
both halves of the boundary: that each key is deterministic and collision-free
(the reason keys live in one place), and that the fields each key is composed
from are actually declared in `feltdb.flow`. Renaming a field in the runtime
without declaring it in the contract fails there.

### Service API generation is deferred, deliberately

**OpenDots does not generate its Hono Service API from `feltdb.flow`.**

The installed FlowSpec format does not currently express service or API
declarations, and OpenDots has no existing generated-Service-API architecture to
adopt. The API is implemented by the domain stores and Hono routes, layered over
the declared collections:

```
Hono routes → domain stores (Store, WorkspaceStore, Pages, ComputerStore)
            → declared FeltDB collections
```

This is a scope boundary, not an unfinished migration. Adding `capability`,
`workflow` or `agent` blocks to the contract today would describe a product that
does not exist — the CLI would accept the syntax, and nothing would implement it.
Revisit when the FlowSpec format can express service declarations and OpenDots
wants them generated; until then the contract describes durable state, and the
domain layer owns application behaviour.

## What moved out of the runtime

The one genuinely implicit value was the collection namespace. It is now derived:

```ts
export const DEFAULT_NAMESPACE = loadContract().app.toLowerCase();
```

There is one source of truth for who OpenDots is. `FELTDB_NAMESPACE` still
overrides it, because two deployments sharing a machine need separate
collections — that is deployment configuration, not architecture.
`FELTDB_PATH` remains environment configuration; a contract that hard-coded a
developer's filesystem path would be worse than useless.

## Enforcement

`openFeltState()` asserts the runtime collection registry against the contract
before opening the state, so an undeclared collection stops startup:

```
FeltDB contract drift:
runtime collection "foo" is not declared in feltdb.flow.
Add the collection to feltdb.flow or remove it from RUNTIME_COLLECTIONS in
src/server/contract.ts.
```

Both remedies are stated, because "it is not declared" alone leaves the reader
guessing which of the two sides is wrong.

`tests/contract-feltdb-flow.test.ts` proves three-way agreement in both
directions:

```
feltdb.flow  ↔  RUNTIME_COLLECTIONS  ↔  MIGRATED_COLLECTIONS
```

An undeclared collection, a declared-but-unused collection, a planner collection
nobody declares, a rename, and a silent removal all fail. There are exactly three
collection lists in the repository — the contract, `RUNTIME_COLLECTIONS`, and
`MIGRATED_COLLECTIONS` — and the test holds them equal, so a fourth could not be
added without breaking it.

The runtime contract behaviour, end to end:

| Situation                                | Result                            |
| ---------------------------------------- | --------------------------------- |
| Valid contract                           | OpenDots starts normally          |
| Runtime collection missing from contract | Startup fails with contract drift |
| Contract collection missing from runtime | Contract validation fails         |
| Namespace                                | Derived from `loadContract().app` |

## An honest limitation

`@feltdb/core` does not export `flowspec` — it is absent from the package's
`exports`, so `parseFlowSpec` and `validateFlowSpec` cannot be imported. The
consequence is that `src/server/contract.ts` reads the declarations it needs by
pattern rather than through the real parser.

That is acceptable **only because** the real parser runs on every CI run. The
module is documented as an accessor, not a validator, and
`tests/contract-feltdb-flow.test.ts` includes a negative control: it proves the
same CLI _rejects_ an invalid contract, so a passing validation is evidence rather
than a vacuous assertion.

If `@feltdb/core` later exports `flowspec`, `readContractSource` should be
replaced by `parseFlowSpec` and this section deleted.

## Testing notes

`tests/runtime-cutover.test.ts` previously generated a fresh random namespace on
every `start()`. That made "a restart" read a _different_ namespace, so the
persistence assertions could not distinguish durable state from a lucky read.
The namespace is now stable for the sandbox lifetime, which is what production
does — `DEFAULT_NAMESPACE` is constant across restarts.

`tests/contract-acceptance.test.ts` is the acceptance test: start with no
SQLite, resolve the contract, boot through the production wiring, create state,
read it back through the application API, restart, read it again, and assert the
SQLite file was never created at any point.

## Migration is unchanged

`migrations/` remains an explicit, admin-only tool. Nothing in `src/` imports it,
startup never calls it, and `data/opendots.sqlite` remains a migration source
rather than runtime state. The contract does not mention the legacy database, and
nothing in the contract depends on it.

## The architecture this produces

OpenDots uses FeltDB as its durable runtime state authority. `feltdb.flow` is
the authoritative application contract for OpenDots' FeltDB collections. SQLite
is retained only as a legacy migration source and is not part of runtime
operation.

```
OpenDots
   │
   ├── feltdb.flow
   │      └── authoritative FeltDB application contract
   │
   ├── domain stores (Store, WorkspaceStore, Pages, ComputerStore, PageThreads)
   │      └── application behaviour
   │
   └── FeltDB
          └── sole runtime durable-state authority

SQLite = legacy migration source  ≠  runtime dependency
```

Two decisions sit behind that diagram, and both are intentional:

- **Domain key schemes remain implementation-level TypeScript**, because the
  installed FlowSpec format does not currently express record-key expressions.
- **The Hono API is implemented by domain stores rather than generated from
  FlowSpec**, because the format does not currently express service/API
  declarations and OpenDots has no generated-Service-API architecture.
