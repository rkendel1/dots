# Intelligence: provider-agnostic model inference

OpenDots requires an **Intelligence capability**, not a specific provider. A
provider is chosen in Setup; every provider is called through the same
OpenAI-compatible chat-completions interface (`@tanstack/ai-openai`), so there
is one model abstraction, not one per provider.

Implementation: [`src/server/intelligence.ts`](../src/server/intelligence.ts).

## Supported providers

| Provider  | Credential variable | Default base URL                | Notes                                    |
| --------- | ------------------- | ------------------------------- | ---------------------------------------- |
| OpenAI    | `OPENAI_API_KEY`    | `https://api.openai.com/v1`     | Native chat-completions                  |
| Anthropic | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/` | Anthropic's OpenAI SDK compatibility API |

A provider is listed only if OpenDots can actually call it through this
interface. Anthropic is reached through its OpenAI-compatible endpoint; its
native Messages API is not used. The request path is covered by automated tests
with a stubbed provider; live calls against each provider are not part of CI.

## Where each piece of configuration lives

| What                          | Where                                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Provider, model, base URL     | Durable Setup configuration in FeltDB (`configurations`)                                                               |
| Provider credential           | Server environment only, via `CredentialResolver`                                                                      |
| Bootstrap defaults (optional) | `INTELLIGENCE_PROVIDER` / `INTELLIGENCE_MODEL` / `INTELLIGENCE_BASE_URL`, or legacy `OPENAI_MODEL` / `OPENAI_BASE_URL` |

### Precedence

Resolved fresh for **every request**, so a change saved in Setup applies to the
next turn without a restart:

1. A value saved in Setup.
2. Otherwise, an environment bootstrap value — but a bootstrap model or base URL
   is applied only to the provider it was written for (`INTELLIGENCE_*` to
   `INTELLIGENCE_PROVIDER`, `OPENAI_*` to OpenAI). An `OPENAI_BASE_URL` can never
   redirect an Anthropic request, or its key, to another host.
3. Otherwise the field is missing and Setup reports it.

## Credentials

Provider keys are never stored by OpenDots:

- They are not fields of the durable configuration, and `PUT /api/configuration`
  rejects a request that includes one.
- `/api/configuration` and `/api/setup/capabilities` report only
  `apiKey.configured` and the variable name to set — never a value.
- The key goes from the `CredentialResolver` straight into the provider client
  for one request and is not logged.

The only `CredentialResolver` today is `EnvironmentCredentials`. AppPort defines a
`ScopedSecretsResolver` protocol, but no implementation that actually holds
secret material exists for OpenDots to delegate to, and OpenDots does not build
its own secret store. When one exists, it replaces `EnvironmentCredentials`
behind the same interface; nothing else changes.

### Migration from earlier builds

An earlier development build could save a provider key into durable
configuration. On startup, `ConfigurationService.scrubPlaintextCredentials()`
removes that field from the live record without reading, logging, or copying the
value. FeltDB keeps an append-only journal, so the old value can remain in the
state directory's journal file until FeltDB compacts it. **If a real key was ever
saved through Setup, revoke it at the provider and issue a new one.**

## What `INTELLIGENCE_API_KEY` was

`INTELLIGENCE_API_KEY` (with `INTELLIGENCE_API_URL` / `INTELLIGENCE_WS_URL`) was
the credential for **CopilotKit's hosted Intelligence service**, which used to
store OpenDots conversations. It was never a model-provider key. OpenDots no
longer uses that service and no longer reads these variables. See
[Self-hosted conversations](SELF-HOSTED-CONVERSATIONS.md).
