# Running the template

OpenDots runs a React app and a Node server. The server stores pages, Space and Dot configuration, Setup configuration, and conversations with their full message history in FeltDB — its sole runtime persistence substrate — and calls the model provider you configure. SQLite is legacy: it is read only by the one-time migration command described in [STORE-FELTDB-PHASE7.md](STORE-FELTDB-PHASE7.md), and never by the running application.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310. Without service credentials, the app shows its setup state; it does not generate simulated replies.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Intelligence and conversations

OpenDots is self-hosted: conversations and their messages are stored in FeltDB, and model calls go directly to the provider you choose. No CopilotKit hosted service or CopilotKit key is involved.

1. Open **Configure infrastructure** in the sidebar (or the Setup screen on first run).
2. Choose a **provider** (Anthropic or OpenAI) and enter a **model**. Save. The next request uses them; no restart is needed.
3. Put that provider's key in the server's `.env` and restart once:

| Variable                                                               | Purpose                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                    | Credential for the Anthropic provider                                        |
| `OPENAI_API_KEY`                                                       | Credential for the OpenAI provider                                           |
| `INTELLIGENCE_PROVIDER`, `INTELLIGENCE_MODEL`, `INTELLIGENCE_BASE_URL` | Optional bootstrap defaults for fields Setup has not saved                   |
| `OPENAI_MODEL`, `OPENAI_BASE_URL`                                      | Legacy OpenAI bootstrap defaults                                             |
| `OWNER_ID`                                                             | Stable identity that owns this deployment's conversations                    |
| `FELTDB_PATH`                                                          | Durable state directory; defaults to `data/opendots-state`                   |
| `FELTDB_NAMESPACE`                                                     | Collection namespace; defaults to the app identity declared in `feltdb.flow` |
| `OWNER_TOKEN`                                                          | Application access token; required for external bindings                     |
| `APP_ORIGIN`                                                           | Exact browser origin when using a proxy or custom domain                     |

Precedence is deterministic: a value saved in Setup always wins; an environment bootstrap value only fills a field Setup has not saved, and a bootstrap model or base URL is only used for the provider it was written for.

Provider keys never enter FeltDB, the Setup read model, any API response, or logs: OpenDots has no credential store, so keys come from the server environment only. Setup shows whether the selected provider's key is present, never its value. Backing up the FeltDB state directory backs up conversation history too.

`INTELLIGENCE_API_KEY`, `INTELLIGENCE_API_URL`, and `INTELLIGENCE_WS_URL` (CopilotKit's hosted service) are no longer read.

## The application contract

`feltdb.flow` at the repository root is the authoritative declaration of OpenDots: the application identity and the durable collections it owns. Startup reads it, and refuses to run if the runtime uses a collection it does not declare.

Validate it after changing it:

```sh
node node_modules/@feltdb/core/bin/feltdb.js validate feltdb.flow
```

Use that exact invocation rather than `npx feltdb`, which can resolve a globally installed FeltDB CLI of a different version and validate against an unpinned grammar. See [docs/CONTRACT-FELTDB-FLOW.md](CONTRACT-FELTDB-FLOW.md).

The legacy `data/opendots.sqlite` file is not part of the contract and is never read at runtime.

OpenDots uses FeltDB as its durable runtime state authority. `feltdb.flow` is the authoritative application contract for OpenDots' FeltDB collections. SQLite is retained only as a legacy migration source and is not part of runtime operation.

Two related boundaries are deliberate:

- Domain key schemes (page, grant, event and review keys) remain implementation-level TypeScript, because the installed FlowSpec format does not currently express record-key expressions. The contract declares the fields those keys are composed from.
- The Hono API is implemented by the domain stores rather than generated from FlowSpec, because the format does not currently express service or API declarations.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without conversation credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot’s settings in the sidebar. The server creates or reuses a conversation for that page and specialist. The Dot receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Dot’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. This requires a working conversation service. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up the FeltDB state directory (`FELTDB_PATH`): it contains page content, configuration, and conversation history. The legacy `data/opendots.sqlite` file is a migration source only and is not part of the backup. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

## Browser tool

The browser service reads a supplied public URL and returns page text and a capture. Configure `BROWSER_URL` and `BROWSER_SECRET`, then run:

```sh
npx playwright install chromium
npm run browser
```

Use the same secret on the app and browser processes. Browser navigation is read-only with JavaScript disabled. Private addresses, redirects, and authenticated pages are unsupported; provide a canonical public URL. This is a bounded research tool, not a general desktop or shell.

## Persistent Dot computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Dot permissions. When computer services are configured, Dots use their computer tools in place of the read-only public-page tool; enable each Dot's required capabilities before use.

## Calls

The included speech adapter uses the Realtime API at `api.openai.com`. Set `VOICE_API_KEY` to a key with access to that API and `VOICE_MODEL` to a supported Realtime model (the local UI test used `gpt-realtime-2.1`); `VOICE_NAME` selects the voice. The Intelligence base URL changes the text model endpoint only, not speech. Calls use browser microphone access and WebRTC. Hosted deployments need HTTPS. The server mediates provider setup and delegates compute to the selected Dot's conversation.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

## Containers

Set `OWNER_TOKEN` and `BROWSER_SECRET` to different random secrets of at least 24 characters in `.env`, then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310. The app port binds to loopback; the browser service has no published port. Application metadata lives in the `opendots-data` volume.

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote hosting, configure an HTTPS reverse proxy and the matching `APP_ORIGIN`. See [Security](../SECURITY.md) for the template's deployment boundary.

## Development checks

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Automated tests use service fixtures. Live model and voice verification requires your own configured provider keys.
