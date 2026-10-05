# Compute 0.1.17 Capability Boundary

## Current State

OpenDots connects to Compute 0.1.17 at the **legitimate capability boundary** — the point where Compute's real, published APIs end and OpenDots' assumptions would begin.

### What Compute 0.1.17 Exposes

Compute 0.1.17 (`compute.remote@1` protocol) provides:

- Workload submission and execution
- Execution status tracking
- Result retrieval
- Receipt/evidence collection
- Workload cancellation
- Portable artifact transport
- Runtime discovery (shell, node, python, ruby, deno, bun, wasm, jvm, dotnet, php, native)
- Health checks and capability queries

### What Compute 0.1.17 Does NOT Expose

- Agent discovery
- Agent invocation capabilities
- Agent provider operations
- Natural-language prompt semantics
- Agent-specific execution protocols

## Integration Model

```
OpenDots
   │
   ├─ Compute Endpoint (COMPUTE_ENDPOINT env var)
   │
   ├─ Capability Discovery
   │     ├─ Health check
   │     ├─ Runtime discovery
   │     └─ Capability reporting
   │
   └─ FeltDB Durable State
         └─ compute_readiness
               ├─ available: boolean
               ├─ protocol: string (compute.remote@1)
               ├─ version: string (0.1.17)
               ├─ runtimes: ComputeRuntime[]
               └─ checkedAt: datetime


Future Seam (Not Yet Available)
   ↓
Compute Agent Capability
   ├─ Agent discovery
   ├─ Agent/provider operations
   ├─ Prompt/context representation
   └─ Agent execution lifecycle
   
   ↓
Configured Agent Runtime
   ↓
Chip (or other future runtimes)
```

## Configuration

Set the Compute endpoint in your environment:

```bash
export COMPUTE_ENDPOINT=http://compute.local:9000
export COMPUTE_AUTHORIZATION=bearer-token-if-required
```

Or via the OpenDots Setup UI in the Compute section.

## Runtime Discovery

OpenDots discovers available runtimes from Compute and persists them in FeltDB.

To see available runtimes:

```bash
compute runtimes --json
```

OpenDots will report which runtimes are:
- installed (embedded in OpenDots)
- available (distributed with Compute)
- unsupported (not available on this platform)

## Architecture Principles

1. **No Chip-specific logic**: OpenDots does not know about Chip, compute-configured-chip, Homebrew paths, or any Chip-specific invocation mechanism.

2. **No fabricated APIs**: OpenDots does not invent `compute.agent.invoke`, `agent.invoke`, or any other API that Compute does not provide.

3. **Durable state only in FeltDB**: Compute readiness is persisted in FeltDB. The application survives restarts without losing what it knew about Compute's capabilities.

4. **Clean capability boundary**: When Compute exposes agent invocation, OpenDots will integrate at that boundary, discovering and using the real capability rather than working around its absence.

5. **Runtime neutrality**: OpenDots is configured to work with any Compute-compatible runtime. Today that's primarily shell, node, and others. Tomorrow it might include new runtimes without requiring OpenDots changes.

## Current Readiness

- ✅ Compute 0.1.17 connectivity
- ✅ Runtime discovery and reporting
- ✅ Capability discovery
- ✅ Durable readiness state in FeltDB
- ✅ UI exposure of Compute status
- ✅ Cold-start recovery
- ❌ Agent invocation (waiting for Compute capability)

## Future: Adding Agent Capabilities

When Compute exposes agent invocation, the integration path will be:

1. Compute publishes an agent capability in its `compute.remote@1` protocol or a new agent-specific protocol
2. OpenDots updates `ComputeCapabilityDiscovery` to recognize and report the agent capability
3. OpenDots creates an `AgentExecutionProvider` implementing the existing `ExecutionProvider` interface
4. The existing execution lifecycle (requested → submitted → running → completed) maps to the Compute agent capability
5. Agent proposal and human decision workflows remain unchanged

No changes to the OpenDots core architecture will be required — the integration will be at the provider boundary, exactly where Compute execution currently lives.

## Architectural Assurances

These patterns **do not appear** in OpenDots:

```
// ❌ Direct Chip invocation
exec("chip ...")
exec("compute-configured-chip ...")
spawn("chip")
spawn("compute-configured-chip")
child_process.exec(...)
child_process.spawn(...)

// ❌ Fabricated agent APIs
compute.agent.invoke()
agent.invoke()
ProviderOperation.Agent

// ❌ Homebrew-specific paths
/opt/homebrew/bin/compute-configured-chip

// ❌ Chip-specific configuration
if (runtime === "chip") { ... }
```

These invariants are protected by tests and architectural guards. Breaking them is a build failure.

## Testing

The test suite verifies:

- Compute connectivity with proper error handling
- Capability discovery from real Compute responses
- No fabricated capabilities
- Durable FeltDB persistence
- Cold-start recovery
- Runtime queries work correctly
- Chip invocation patterns do not appear in the codebase
- Agent capability boundary is respected

Run tests with:

```bash
npm test -- tests/compute-capability-integration.test.ts
```

## See Also

- [docs/EXECUTION-ARCHITECTURE.md](./EXECUTION-ARCHITECTURE.md) — How OpenDots execution works
- [src/server/compute-capability-discovery.ts](../src/server/compute-capability-discovery.ts) — Real Compute API calls
- [src/server/compute-readiness-store.ts](../src/server/compute-readiness-store.ts) — FeltDB persistence
- [src/server/compute-execution-provider.ts](../src/server/compute-execution-provider.ts) — Workload execution (existing)

## Final Verdict

**READY AT CAPABILITY BOUNDARY — COMPUTE AGENT CAPABILITY MISSING**

This is the correct architectural outcome for Compute 0.1.17. OpenDots is genuinely connected to Compute, can discover and report its real capabilities, and clearly communicates that agent execution is not yet available—without inventing APIs or taking the shortcut of invoking Chip directly.
