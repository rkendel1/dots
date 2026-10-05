# OpenDots execution architecture

How OpenDots asks for work to be run, and where the boundary with Compute is.

## The shape

```
OpenDots                     control plane
    │
    │  Work / Task
    ▼
ExecutionStore               durable record in FeltDB
    │
    ▼
ExecutionService             ordering, idempotency, reconciliation
    │
    ▼
ExecutionProvider            the whole of what OpenDots knows
    │
    ▼
ComputeExecutionProvider     speaks compute.remote@1
    │
    ▼
Compute                      execution plane
    │
    ▼
execution environment        (may contain Chip)
```

Chip sits below Compute and is **not** part of this change. OpenDots does not
import it, depend on it, configure it, or know it exists.

## The dependency direction

```
OpenDots ──▶ Compute
```

and never the reverse, and never `OpenDots ──▶ Chip ──▶ Compute`. Chip is
downstream of Compute: OpenDots talks to the execution plane, and whatever runs
inside it is the execution plane's business.

## What `executions` is, and why it is not `runs`

`feltdb.flow` declares 20 collections. Two were added for execution control and
attention: `executions` and `attention`.

It is deliberately **not** a duplicate of the existing `runs` collection:

|                    | `runs`                                   | `executions`                                                             |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------ |
| Created by         | a task claim, inside this process        | a user/API request                                                       |
| Identity           | `id` is the lease                        | derived from the request's idempotency key                               |
| Owner              | the worker holding the lease, in-process | an external provider                                                     |
| Outlives a request | no — it ends with its lease              | yes — it survives restarts                                               |
| Provider           | none                                     | `provider`, `providerExecutionId`, `providerSessionId`, `providerStatus` |
| Settled by         | `Store.finish` / `Store.fail`            | only by what the provider reports                                        |
| Reconcilable       | no                                       | yes — `GET /executions/:id` re-reads it                                  |

A `run` is an in-process attempt whose lifetime is bounded by a lease. An
execution is someone else's work that OpenDots asked for and then merely
observes. Merging them would have forced one of the two to lose its identity.

## The provider boundary

`ExecutionProvider` (`src/server/execution-provider.ts`) is the entire surface:

```ts
interface ExecutionProvider {
  readonly name: string;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
  getStatus(execution: ExecutionHandle): Promise<ExecutionStatusReport>;
  cancel?(execution: ExecutionHandle): Promise<void>;
  ready(): Promise<boolean>;
}
```

The domain above it knows only that work was requested, started, is running,
finished, or went wrong. It does not know that Compute has thirteen statuses, or
that one of them is called `waiting_for_capacity`.

`ExecutionRequest` deliberately carries only what OpenDots owns — a prompt, and
optional context — plus the identity links and the idempotency key. Turning that
into a runnable artifact is the provider's job.

## The Compute contract actually used

OpenDots speaks **`compute.remote@1`**, the versioned HTTP protocol declared in
`compute-provider/src/lib.rs` (`REMOTE_PROTOCOL`) and served by `compute serve` or
by a node acting as a provider.

| Purpose              | Method + path                     | Compute operation |
| -------------------- | --------------------------------- | ----------------- |
| readiness            | `GET  /compute/health`            | `Health`          |
| submit a durable job | `POST /compute/jobs`              | `Submit`          |
| read status          | `GET  /compute/jobs/{id}`         | `Status`          |
| read the result      | `GET  /compute/jobs/{id}/result`  | `Result`          |
| verifiable evidence  | `GET  /compute/jobs/{id}/receipt` | `Receipt`         |
| cancel               | `POST /compute/jobs/{id}/cancel`  | `Cancel`          |

Requests carry `X-Compute-Protocol: compute.remote@1`, an optional
`Authorization`, and — on submission — `Idempotency-Key`.

Nothing in this repository invents an endpoint. `POST /compute/execute` does exist
in Compute, as a synchronous variant, but the durable, idempotent,
status-addressable `POST /compute/jobs` is what an execution control plane needs,
and it is what is used here.

### Vocabulary mapping

Compute's `JobStatus` has thirteen values. OpenDots has six. The mapping lives in
`normalizeExecutionStatus`, listed exhaustively so that a Compute release adding
or renaming a status **fails the build** instead of being silently mapped:

| Compute                                                         | OpenDots    |
| --------------------------------------------------------------- | ----------- |
| `created` `accepted` `queued` `waiting_for_capacity` `reserved` | `queued`    |
| `admitted` `preparing`                                          | `starting`  |
| `running`                                                       | `running`   |
| `succeeded`                                                     | `completed` |
| `failed` `rejected` `timed_out`                                 | `failed`    |
| `cancelled`                                                     | `cancelled` |

Only `succeeded` completes an execution. A timeout, a rejection, or a terminal
status this build does not recognise all resolve to `failed` — an execution whose
real outcome is unknown must never be reported as finished successfully.

The provider's own word is kept on the record as `providerStatus`, so the
normalization is auditable rather than lossy, and the UI shows both when they
disagree.

## Idempotency

Compute's `Idempotency-Key` header, validated locally against Compute's own rules
(1–256 bytes, no control characters) before any round trip.

On the OpenDots side the record key **is** the request identity:

```
exec_<sha256(idempotencyKey)>
```

That is what makes `create` atomic. A `requireAbsent` guard protects the record
key, so deriving the key from the request means two concurrent requests carrying
the same key address the same record: one wins, the other reads back the winner's
execution. The unique index on `idempotencyKey` in `feltdb.flow` is a second line
of defence, not the mechanism — so a future change to the key derivation cannot
silently weaken the guarantee.

The retry story:

```
Run Task
   ↓
execution created        ← durable, written before the provider is contacted
   ↓
request sent
   ↓
network timeout
   ↓
retry with the same key
   ↓
same execution record, same provider job
```

The API requires the client to send `idempotencyKey` and returns `created: false`
for a repeat, so the client can tell "I started this" from "this already existed".

## Recovery

Execution state is durable in FeltDB and is never inferred from the fact that a
process restarted. On startup `ExecutionService.recover()` reconciles every
non-terminal execution against the provider and records what the provider says.

An execution the provider has never heard of is recorded as `failed` with
Compute's own `unknown_job` code — not left `running` forever, and never assumed
complete.

Intent is written _before_ the provider is contacted. If the process dies
mid-request the intent survives and recovery picks it up; the opposite order would
leave a Compute job running that OpenDots has no record of.

## Known boundaries

These are real gaps, stated rather than papered over.

### Compute has no prompt input

`ProviderRequest` carries an **artifact** — a workload to execute — and nothing
else. There is no field for a natural-language prompt anywhere in
`compute.remote@1`.

OpenDots therefore wraps the prompt in the smallest honest workload it can: a
`shell` runtime `WorkloadSpec` whose entrypoint is a one-line script copying
`prompt.txt` to the declared output. The prompt travels as a real workload input.

**Consequence:** what comes back is whatever that workload produced — an exit
code, stdout/stderr and, once an agent runtime is involved downstream, whatever
that runtime chose to write. It is _not_ a language-model answer, and nothing in
OpenDots presents it as one.

> OpenDots requires a way to submit an agent prompt to Compute.
> Compute currently exposes only workload artifacts.
> Therefore prompt-shaped execution cannot be implemented without inventing a new
> Compute API — so it is not implemented. OpenDots encodes the prompt as a
> workload, which is real, and says plainly what that does and does not buy.

### Receipts are stored but not yet projected

Compute exposes verifiable execution receipts at
`GET /compute/jobs/{id}/receipt`, and `ExecutionResult` carries a `receipt`
field. OpenDots stores the `ExecutionResult` verbatim in `result`, so the evidence
is preserved and available — but the API does not yet project a dedicated receipt
endpoint, and no test asserts on receipt contents.

### Results are only read once terminal

`GET /compute/jobs/{id}/result` is requested only after the job status is
terminal. Asking earlier returns a provider error, not an empty result, and
inventing an empty one would be exactly the fabrication this boundary exists to
prevent.

### No polling loop

OpenDots reconciles on startup, on an explicit read, and on user action. It does
not run a timer of its own, because the Compute contract does not require one. A
long-running execution therefore advances when it is next looked at.

## Configuration

| Variable                | Meaning                                                |
| ----------------------- | ------------------------------------------------------ |
| `COMPUTE_ENDPOINT`      | Base URL of a Compute node serving `compute.remote@1`. |
| `COMPUTE_AUTHORIZATION` | Optional `Authorization` header value.                 |

With no `COMPUTE_ENDPOINT` there is **no** execution provider, and that is the
normal case: OpenDots starts, runs and is fully usable without Compute, because
Compute — and the agent runtime behind it — is released independently. The API
answers `503` with an explanatory message, and the UI disables Run rather than
offering a button that cannot work.

There is deliberately no default endpoint and no discovery.

## API

| Route                             | Purpose                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| `GET  /api/executions`            | list, optionally `?taskId=`; reports the provider name or `null` |
| `POST /api/executions`            | request one; requires `idempotencyKey`                           |
| `GET  /api/executions/:id`        | read one, reconciled against the provider                        |
| `POST /api/executions/:id/cancel` | ask the provider to stop it                                      |

There is deliberately **no** `PATCH /api/executions/:id`. Execution status is not
client-writable: it changes only as a result of what the provider reports, so the
UI cannot put an execution into a state the provider never entered.

## Attention — the control plane's own layer

Reconciliation makes execution state agree with Compute. Attention answers the
next question: _what does a human need to know or decide right now?_

```
ExecutionReconciler ──▶ durable execution state
                             │
                             ▼
                      AttentionEvaluator        the judgement
                             │
                             ▼
                      AttentionStore            durable, in FeltDB
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
              /api/attention    /context (read live)
```

### Identity is the deduplication mechanism

An item's id is `attentionIdFor(kind, sourceType, sourceId)` — a hash of _what
the condition is about_. Evaluating the same condition a thousand times therefore
addresses one record, and convergence is a property of the key rather than of a
check-then-write that could race. No random UUID appears anywhere in the
deduplication path, and the write is create-only, so a cycle running every few
seconds cannot reset `createdAt` or overwrite a human's decision.

The same shape as `executionIdFor`, for the same reason.

### Two clocks, not one

| Field                | Set by     | Means                                       |
| -------------------- | ---------- | ------------------------------------------- |
| `conditionClearedAt` | the system | the condition stopped being true            |
| `resolvedAt`         | a person   | someone decided this no longer needs anyone |

Conflating them would let a provider recovering from an outage masquerade as a
human having dealt with it. An item whose condition has cleared leaves the
"needs attention" list while staying `open` until someone resolves it — and a
**failed execution never auto-resolves at all**, because reaching a terminal state
is not the same as being dealt with.

### Context is resolved, never stored

`GET /api/attention/:id/context` walks Attention → Work → Task → Execution →
Compute job → Result/Receipt on every request. An item holds a reference
(`sourceType`, `sourceId`) and nothing else about its source, so a control-plane
view cannot report an execution as `running` after it finished. A link that no
longer exists is reported as `sourceMissing` rather than omitted.

### One trigger, no second loop

Attention is evaluated from `ExecutionReconciler`'s `onCycleComplete`, after the
cycle's state has settled. A separate poller would either duplicate the
reconciliation work or disagree with it about what is true, and a control-plane
failure is reported without stopping execution reconciliation.

### Deliberately not added

No retry, no edit, no provider change, no prompt edit, no cancel action. The API
exposes exactly two mutations — acknowledge and resolve — and cannot create, edit
or invent an item. No WebSockets, queues, push, email or SMS: the UI reads
durable state through the existing API.

## Testing

| Suite                                     | Proves                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `tests/executions.test.ts`                | lifecycle, persistence, idempotency, recovery, cancellation            |
| `tests/execution-api.test.ts`             | `API → domain → FeltDB`                                                |
| `tests/compute-provider-contract.test.ts` | the routes, headers, vocabulary and error shapes of `compute.remote@1` |
| `tests/execution-ui.test.tsx`             | the panel renders what the API returned                                |
| `tests/attention.test.ts`                 | conditions, dedup, outage, recovery, ack/resolve, restart              |
| `tests/attention-api.test.ts`             | the two actions over HTTP, filters, live context, staleness            |
| `tests/attention-ui.test.tsx`             | acknowledged ≠ resolved ≠ condition-cleared, in the markup             |
| `tests/attention-integration.test.ts`     | the real path, end to end, on the real Compute adapter                 |

The Compute contract tests stub the **transport**, not the protocol: every request
the adapter makes is asserted for its exact method, path and headers, and every
response is a literal shaped like the real one. No Compute instance is started
and none is required.

`tests/attention-integration.test.ts` drives the whole chain — Work → Task →
`ComputeExecutionProvider` → `ExecutionReconciler` → `AttentionEvaluator` →
FeltDB → API — with no scripted provider. Its transport answers **only** the
routes Compute declares, so an invented endpoint fails loudly rather than
quietly passing.

`ScriptedExecutionProvider` (`tests/helpers/`) is **test infrastructure only**.
Its provider name is `scripted-test`, so a scripted execution is visibly
scripted in the durable record, the API and the UI; it issues no Compute-shaped
`job_…` identity and fabricates no receipt or result payload; it lives under
`tests/` and is excluded from the published package; and no environment variable
or default can select it — `computeProviderFromEnv` reads exactly one variable
and builds exactly one provider.

## What was deliberately not added

No Redis, queue, second database, event bus, background worker, or polling
infrastructure. OpenDots uses the stack it already had: FeltDB for durable state,
and the provider boundary for everything else.
