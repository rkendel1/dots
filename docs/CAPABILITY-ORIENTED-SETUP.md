# Capability-Oriented Setup

## Overview

OpenDots Setup now presents **capabilities** rather than implementation details. Users configure what OpenDots can do, not how the infrastructure behind those capabilities works.

## Architecture

### Before: Implementation-Focused

```
Intelligence
├─ API URL
├─ WebSocket URL
├─ Model
├─ Base URL
├─ API Key
Computers
├─ Namespace
├─ Memory bytes
├─ Runtime
├─ Engine Socket
├─ Supervisor Token
├─ Computer Token
```

This exposed infrastructure plumbing—namespaces, sockets, memory configuration—as if OpenDots owned those concerns. It didn't.

### After: Capability-Focused

```
Intelligence (Required)    ● Ready
  Provider: OpenAI
  Model: gpt-4
  API Key: ● Configured

Computers (Optional)       ● Connected
  Capabilities: Workload execution

Browser (Optional)         ○ Not connected
Voice (Optional)           ○ Not configured
Slack (Optional)           ○ Not connected
```

The UI shows:
- **What OpenDots can do** (capabilities)
- **What's configured** (status)
- **Provider information** where relevant

It does not show:
- Infrastructure internals
- Implementation details
- Secrets (only status)

## Capabilities

### Intelligence (Required)

OpenDots requires an Intelligence capability to operate.

**Status values:**
- `not_configured` — No provider selected
- `ready` — Provider is configured and ready

**Exposes:**
- `provider` — Which provider is active (e.g., OpenAI)
- `model` — The configured model
- `credentialConfigured` — Whether credentials are present (status only, never the value)

**Design principle:**
- Intelligence is provider-agnostic
- The capability comes first; the provider is an implementation detail
- Users select a provider (OpenAI, Anthropic, etc.)
- Each provider has its own required fields

### Computers (Optional)

Computers integrate via the Compute capability boundary.

**Status values:**
- `not_configured` — Compute not connected
- `ready` — Compute is available
- `error` — Compute was reachable but reported an error

**Exposes:**
- `endpoint` — The Compute endpoint (if configured)
- `capabilities` — What Compute actually reports (e.g., "workload execution")
- `reason` — Error message if applicable

**Design principle:**
- OpenDots consumes Compute's real capability contract
- Does not probe Docker, runsc, Chip, Homebrew, or other Compute internals
- Reports only capabilities that Compute actually advertises
- Infrastructure details (namespace, memory, runtime) stay inside Compute

### Browser (Optional)

Browser provides access to a browser service.

**Status values:**
- `not_configured` — No browser service URL
- `ready` — Browser service is configured

**Exposes:**
- `url` — The browser service URL (if configured)

### Voice (Optional)

Voice provides speech I/O and depends on Intelligence.

**Status values:**
- `not_configured` — Voice is not configured or Intelligence is unavailable
- `ready` — Voice is configured and Intelligence is ready

**Exposes:**
- `provider` — Voice provider information
- `model` — Voice model
- `voice` — Voice selection (e.g., specific voice name)
- `credentialConfigured` — Credential status
- `reason` — If not configured, why (e.g., "requires Intelligence")

**Design principle:**
- Voice requires Intelligence as a capability dependency (not OpenAI specifically)
- If Intelligence is configured with another provider, Voice should work accordingly
- The dependency is expressed as a capability relationship

### Slack (Optional)

Slack provides Slack workspace integration.

**Status values:**
- `not_configured` — Slack is not connected
- `ready` — Slack is connected and configured

**Exposes:**
- `channel` — Connected channel name
- `team` — Team ID (infrastructure detail, shown but not primary)

## API

### GET /api/setup/capabilities

Returns the capability-oriented Setup model:

```json
{
  "intelligence": {
    "required": true,
    "status": "ready",
    "provider": "openai",
    "model": "gpt-4",
    "credentialConfigured": true
  },
  "computers": {
    "required": false,
    "status": "ready",
    "capabilities": ["workload execution"],
    "endpoint": "http://localhost:9000"
  },
  "browser": {
    "required": false,
    "status": "not_configured"
  },
  "voice": {
    "required": false,
    "status": "not_configured",
    "reason": "requires Intelligence capability"
  },
  "slack": {
    "required": false,
    "status": "not_configured"
  }
}
```

Secrets are **never exposed**. Only `credentialConfigured: true/false` appears.

### Backward Compatibility

The existing `/api/configuration` endpoint remains unchanged. It returns the full configuration read model with all fields (including infrastructure details).

The new `/api/setup/capabilities` endpoint is for the Setup UI.

Both exist together:
- Setup UI consumes `/api/setup/capabilities` (capability view)
- Advanced configuration consumes `/api/configuration` (detailed view)
- Both draw from the same underlying configuration state

## Implementation Details

### buildCapabilityStatus()

Transforms the full configuration read model into the capability-focused view:

```typescript
const capabilities = buildCapabilityStatus(config, computeState);
```

This function:
- Derives capability status from configuration
- Consumes real Compute readiness state (not infrastructure inspection)
- Never invents capabilities
- Preserves all underlying configuration (no data loss)
- Never exposes secrets

### Secret Safety

The capability status model enforces the existing secret-safety invariant:

1. ✅ **Credentials are never exposed** — Only status (`credentialConfigured`)
2. ✅ **Infrastructure is abstracted** — Only capabilities matter
3. ✅ **Compute owns its details** — OpenDots doesn't probe Docker, runsc, etc.
4. ✅ **Environment separation** — Secrets come from env, not FeltDB

## Progressive Disclosure

The primary Setup screen shows capabilities. Infrastructure details remain available but are not primary.

Example workflow:

1. **Setup screen** shows "Computers: Not connected"
2. **User clicks "Configure Computers"**
3. **Configuration form** shows provider options and connection details

Advanced settings remain available for operators who need them, but they don't dominate the first-time experience.

## Capability Dependencies

### Expressed Dependencies

- Voice → Intelligence (not OpenAI specifically)
  - Voice requires an Intelligence capability
  - Works with any Intelligence provider

### Not Expressed as Dependencies

- ~~Voice → OpenAI~~
- ~~Computers → Docker~~
- ~~Computers → runsc~~
- ~~Computers → Chip~~

These are implementation details, not capability dependencies.

## Testing

The capability status model is tested at the boundary:

- Configuration state → Capability status (pure function)
- No infrastructure inspection
- No secret exposure
- Capability derivation is verifiable

See `tests/capability-status.test.ts` for the test suite.

## UI Consumption

The React Setup UI consumes `/api/setup/capabilities` and renders:

1. **Capability cards** showing status
2. **Configure buttons** for unconfigured capabilities
3. **Status indicators** (● ready, ○ not configured, etc.)
4. **Provider information** where relevant
5. **Never secrets** — Only configured/not configured

Example rendering:

```
OpenDots Setup

Intelligence        Required    ● Ready
  Provider: OpenAI
  Model: gpt-4
  API Key: Configured

Computers           Optional    ● Connected
  Capabilities: [...]

Browser             Optional    ○ Not connected
Voice               Optional    ○ Not configured
Slack               Optional    ○ Not connected
```

## Future Work

As new capabilities are added:

1. Define the capability interface (status values, fields)
2. Update `SetupCapabilitiesModel` type
3. Add capability derivation logic in `buildCapabilityStatus()`
4. Add tests
5. Update UI to render the new capability

No changes needed to configuration persistence, secrets handling, or the fundamental architecture.

## See Also

- [docs/INTELLIGENCE-PROVIDER-AGNOSTIC.md](./INTELLIGENCE-PROVIDER-AGNOSTIC.md) — Provider selection
- [docs/COMPUTE-CAPABILITY-BOUNDARY.md](./COMPUTE-CAPABILITY-BOUNDARY.md) — Compute integration
- [src/server/capability-status.ts](../src/server/capability-status.ts) — Capability derivation
- [src/server/configuration-routes.ts](../src/server/configuration-routes.ts) — API endpoints
- [tests/capability-status.test.ts](../tests/capability-status.test.ts) — Tests

## Final Verdict

**OPEN DOTS SETUP IS CAPABILITY-ORIENTED — IMPLEMENTATION DETAILS HIDDEN**

Users configure capabilities. Infrastructure details remain available for advanced use but are not the primary Setup experience.
