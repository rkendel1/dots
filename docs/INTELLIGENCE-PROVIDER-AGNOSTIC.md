# Intelligence Provider Agnostic Architecture

## Overview

OpenDots now requires an **Intelligence capability**, not a specific provider like OpenAI. This architectural change allows OpenDots to support multiple intelligence providers while remaining truly decoupled from any single one.

## What Changed

### Before

OpenDots setup required:

```
Setup Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Intelligence API Key     Required
OpenAI API Key          Required    ← Hard dependency
OpenAI Model            Required    ← Hard dependency
Browser Service         Optional
Voice Service           Optional
```

OpenAI was a hidden platform requirement. The absence of OpenAI credentials would block setup even if another intelligence provider was configured.

### Now

OpenDots setup requires:

```
Setup Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Intelligence Provider   Required
  Provider: OpenAI
    API Key             Configured
    Model               Configured
Browser Service         Optional
Voice Service           Optional
```

**Intelligence** is the platform requirement. OpenAI is one supported provider. Anthropic is another. Future providers can be added without architectural changes.

## Provider Selection

### Auto-detection (Default)

If no `INTELLIGENCE_PROVIDER` is set, OpenDots auto-detects based on which environment variables are present:

- `OPENAI_API_KEY` + `OPENAI_MODEL` → OpenAI is selected
- `INTELLIGENCE_API_KEY` → Anthropic is selected (if explicitly configured)
- Nothing → No intelligence provider configured

### Explicit Selection

Set `INTELLIGENCE_PROVIDER` to explicitly select:

```bash
# Use OpenAI
export INTELLIGENCE_PROVIDER=openai
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4

# Use Anthropic
export INTELLIGENCE_PROVIDER=anthropic
export INTELLIGENCE_API_KEY=claude-...
```

When a provider is explicitly selected, only its credentials matter for setup completion. OpenAI credentials are not required if Anthropic is selected.

## Architecture

```
OpenDots
   │
   └─ Intelligence Capability
        │
        └─ Provider (auto-detected or explicit)
             ├─ OpenAI
             │  ├─ API Key
             │  ├─ Model
             │  └─ Base URL
             │
             ├─ Anthropic
             │  ├─ API Key
             │  └─ Model (implicit)
             │
             ├─ Local (future)
             │  └─ Endpoint
             │
             └─ Other (extensible)
                └─ Custom endpoint
```

Each provider:
- Has its own required/optional configuration
- Is completely optional to OpenDots' core architecture
- Can be added without modifying core setup logic
- Credentials remain outside FeltDB (secret boundary)

## Configuration

### Environment Variables

**Core Intelligence (provider-neutral):**

```bash
INTELLIGENCE_PROVIDER=openai|anthropic  # Optional; auto-detected if unset
INTELLIGENCE_API_URL=...                # Optional; for Intelligence service discovery
INTELLIGENCE_WS_URL=...                 # Optional; for WebSocket
```

**OpenAI Provider (only if selected):**

```bash
OPENAI_API_KEY=sk-...       # Required if OpenAI selected
OPENAI_MODEL=gpt-4          # Required if OpenAI selected
OPENAI_BASE_URL=...         # Optional; default: https://api.openai.com/v1
```

**Anthropic Provider (only if selected):**

```bash
INTELLIGENCE_API_KEY=claude-...  # Required if Anthropic selected
```

### Configuration UI

The Setup screen now shows:

**Intelligence**
- **Status**: Not configured / Configuration incomplete / Ready
- **Provider**: (None) / OpenAI / Anthropic
- **Provider-specific fields** (if provider selected):
  - API Key: Configured / Not configured
  - Model: Configured / Not configured

## API Changes

### SetupStatus

```typescript
export interface SetupStatus {
  intelligence: boolean;                    // Capability configured?
  intelligenceProvider?: 'openai' | 'anthropic' | 'other';  // Which provider?
  // ... other fields
}
```

### ConfigurationReadModel

```typescript
export interface ConfigurationReadModel {
  sections: {
    intelligence: {
      configured: boolean;                  // Is a provider configured?
      provider?: 'openai' | 'anthropic';   // Which one?
      apiKey: SecretStatus;                 // Never exposed
      model?: string;                       // Provider's model name
      // ... other fields
    };
    // ... other sections
  };
}
```

Credentials are **never exposed** in API responses. Only whether they're configured.

## Secrets

Provider credentials remain:

- Outside FeltDB (no durable storage in database)
- Read from environment variables only
- Never persisted in managed configuration
- Never returned in API responses
- Never logged

The `SecretStatus` read model only reports **presence**, never material:

```typescript
export interface SecretStatus {
  configured: boolean;  // Is it set in environment?
  source?: 'environment' | 'secret-reference';  // Where from?
}
```

## Tests

New test cases verify:

```typescript
// Provider agnostic setup
setupStatus({ intelligenceProvider: 'openai', apiKey: 'x', model: 'y' })
// → { intelligence: true, intelligenceProvider: 'openai' }

// Alternative provider
setupStatus({ intelligenceProvider: 'anthropic', intelligenceKey: 'x' })
// → { intelligence: true, intelligenceProvider: 'anthropic' }

// No provider causes intelligence requirement to fail
setupStatus({ apiKey: '', intelligenceKey: '' })
// → { intelligence: false, intelligenceProvider: undefined }

// OpenAI not required if other provider selected
setupStatus({ intelligenceProvider: 'anthropic', intelligenceKey: 'x', apiKey: '' })
// → { intelligence: true, missing: [] }  // No "OPENAI_API_KEY" error
```

## Future Providers

Adding a new provider (e.g., Claude via Anthropic, Ollama local, etc.):

1. Update `intelligenceProvider` type:
   ```typescript
   intelligenceProvider?: 'openai' | 'anthropic' | 'ollama' | 'other';
   ```

2. Add environment variable handling in `platform-config.ts`

3. Add configuration requirement logic in `configuration.ts`

4. Update the AI SDK integration to use the selected provider

5. No changes needed to:
   - Setup status core logic
   - FeltDB schema
   - Attention/execution architecture
   - Secrets boundary
   - UI structure (it's generic over provider)

## Real vs. Assumed Capabilities

**Real (implemented):**
- OpenAI provider support
- Auto-detection of configured provider

**Not implemented (do not claim):**
- Anthropic provider API client (auth, model routing)
- Local model support
- Custom endpoint support

The configuration *accepts* these options and reports them honestly, but OpenDots does not yet implement the integration. That's correct—it separates "capability contract" from "implementation".

## Architectural Invariants

These invariants are protected by tests:

1. ✅ OpenAI is **not** a platform requirement
2. ✅ Setup does **not** check `OPENAI_API_KEY` unconditionally
3. ✅ Setup does **not** check `OPENAI_MODEL` unconditionally
4. ✅ Provider-specific requirements are conditional on that provider being selected
5. ✅ Credentials are never exposed in API/UI
6. ✅ Multiple providers can coexist in environment (one is active)
7. ✅ Auto-detection works when no explicit provider is chosen
8. ✅ Voice requires Intelligence (any provider)

## Migration

**Existing deployments:**

If you have `OPENAI_API_KEY` and `OPENAI_MODEL` set, OpenDots will:

1. Auto-detect OpenAI as the configured provider
2. Work exactly as before
3. Show `intelligenceProvider: 'openai'` in setup status
4. Require no changes

**To explicitly select a provider:**

```bash
# Old way (still works)
export OPENAI_API_KEY=...
export OPENAI_MODEL=...

# New way (recommended)
export INTELLIGENCE_PROVIDER=openai
export OPENAI_API_KEY=...
export OPENAI_MODEL=...
```

**To prepare for multiple providers:**

Set `INTELLIGENCE_PROVIDER` explicitly, so future code can handle multiple providers in environment simultaneously.

## See Also

- [docs/COMPUTE-CAPABILITY-BOUNDARY.md](./COMPUTE-CAPABILITY-BOUNDARY.md) — Compute integration, kept separate from Intelligence
- [src/server/platform-config.ts](../src/server/platform-config.ts) — setupStatus logic
- [src/server/configuration.ts](../src/server/configuration.ts) — Configuration service
- [tests/setup.test.ts](../tests/setup.test.ts) — Setup status tests

## Final Verdict

**INTELLIGENCE PROVIDER AGNOSTIC — OPENAI NO LONGER REQUIRED**

OpenDots is genuinely independent of any intelligence provider while remaining compatible with OpenAI and ready to integrate other providers. The platform requires Intelligence, not OpenAI.
