# Self-hosted conversations

OpenDots owns its conversation state. CopilotKit is used as an open-source
library — React chat components and the runtime that speaks the AG-UI protocol —
but **no CopilotKit hosted service is required or contacted**: not for
conversation storage, not for model inference, and not for telemetry.

## Ownership boundaries

| Concern                            | Owner                                           |
| ---------------------------------- | ----------------------------------------------- |
| Provider credentials               | Server environment, behind `CredentialResolver` |
| Provider and model configuration   | OpenDots durable configuration (FeltDB)         |
| Conversations, runs, and messages  | FeltDB                                          |
| Model inference                    | Intelligence capability (`IntelligenceService`) |
| Computer / workload execution      | Compute (unchanged by this design)              |
| Chat UI, streaming, tool rendering | CopilotKit React + runtime libraries            |

## Chat request lifecycle

```
Chat UI (CopilotKit React)
  │  POST /api/copilotkit/agent/:dotId/run   (AG-UI over SSE)
  ▼
runtime-scope check ── conversation must belong to this owner and Dot
  ▼
CopilotKit runtime, SSE mode
  ▼
FeltAgentRunner
  ├─ loads prior runs from FeltDB (owner-scoped)
  ├─ runs DotAgent
  │     └─ IntelligenceService.resolveModel()
  │           ├─ provider / model / base URL ← Setup configuration (FeltDB)
  │           └─ credential ← CredentialResolver (environment)
  │     └─ OpenAI-compatible provider request (Anthropic or OpenAI)
  ├─ streams events to the client
  ├─ writes the run and the resulting messages to FeltDB in one transaction
  └─ only then emits RUN_FINISHED
```

The terminal event is held back until the FeltDB write commits, so a request
never reports success for a conversation that is not durable. If the write
fails, the client receives `RUN_ERROR`.

Server-initiated turns (scheduled tasks, voice compute) call
`Platform.turn`, which runs the same `DotAgent` through the same runner, so they
are persisted identically and see the same history.

## Storage model

A conversation is the existing `thread_bindings` row (id, Dot, owner, title,
created). Two collections hold what CopilotKit's hosted service used to:

- **`conversation_runs`** — one row per finished run: its compacted AG-UI events
  and a status of `completed` or `interrupted`. Replaying these events is how the
  chat UI restores a conversation (`POST /api/copilotkit/agent/:dotId/connect`).
- **`conversation_messages`** — the conversation's messages as of the last
  _completed_ run. An interrupted or failed run never writes here, so a partial
  stream is never mistaken for a finished assistant message.

Process memory holds only the run that is executing right now (to stop it and to
let a second client attach). Everything else is read from FeltDB, so a restart
loses nothing that completed.

## Owner isolation

Every read and write goes through `WorkspaceStore.requireThread`, which only
sees the current owner's conversations. A conversation id alone never reaches
another owner's history: reading, appending, and replaying a foreign
conversation are rejected, and the runtime route returns 403 before any agent
runs.

## What was removed

| Removed                                         | Why                                                        |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `CopilotKitIntelligence` client                 | Hosted conversation storage; replaced by FeltDB            |
| `INTELLIGENCE_API_KEY` / `_API_URL` / `_WS_URL` | Credentials and endpoints for that hosted service          |
| Slack (`@copilotkit/channels`)                  | CopilotKit Channels only run on the hosted runtime         |
| Automatic Learning / skill delivery             | Learning Containers only run on the hosted runtime         |
| `useThreads` in the sidebar                     | Hosted thread listing; the sidebar uses OpenDots' own list |
| CopilotKit telemetry                            | Disabled by default (`COPILOTKIT_TELEMETRY_DISABLED=true`) |
| CopilotKit web inspector                        | Disabled (`enableInspector={false}`)                       |

Stored Dot fields from the Learning integration (`learningContainerId`,
`skillDeliveryEnabled`) are kept in the schema so existing state still loads, but
nothing reads them.

## Verification

- `tests/self-hosted-conversations.test.ts` — Setup-configured chat through the
  real runtime route, provider request built from Setup values, durable history,
  replay after reopening the state, continuation with history, interrupted runs,
  owner isolation, and late-joining clients. It also asserts the only outbound
  request in a chat turn is to the configured provider.
- `tests/restart-process.test.ts` — starts the real server process, configures it
  over HTTP, chats, stops it, starts a new process on the same state directory,
  and recovers configuration and history.
- `tests/intelligence.test.ts`, `tests/configuration.test.ts` — provider
  resolution, precedence, credential custody, and the plaintext-credential scrub.
