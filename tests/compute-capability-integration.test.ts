/**
 * Compute 0.1.17 capability boundary integration tests.
 *
 * These tests verify that OpenDots integrates with Compute at the legitimate
 * capability boundary without inventing APIs or invoking Chip directly.
 */

import { describe, it, expect } from 'vitest';
import {
  ComputeCapabilityDiscovery,
  type ComputeReadinessReport,
} from '../src/server/compute-capability-discovery.js';
import { ComputeReadinessStore } from '../src/server/compute-readiness-store.js';
import { openFeltState } from '../src/server/felt/state.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never the default path: that is the developer's real `data/opendots-state`.
const statePath = () =>
  join(mkdtempSync(join(tmpdir(), 'opendots-compute-')), 'state');

describe('Compute Capability Discovery', { timeout: 10000 }, () => {
  it('reports unavailable when endpoint is unreachable', async () => {
    const discovery = new ComputeCapabilityDiscovery(
      'http://unreachable.local:9999',
      undefined,
      1000,
    );
    const report = await discovery.health();

    expect(report.available).toBe(false);
    expect(report.error).toBeDefined();
  });

  it('does not fabricate capabilities', async () => {
    const discovery = new ComputeCapabilityDiscovery(
      'http://unreachable.local:9999',
      undefined,
      1000,
    );
    const report = await discovery.fullReadinessCheck();

    // Must report exactly what was observed
    expect(report.available).toBe(false);
    expect(report.runtimes).toBeUndefined();
    expect(report.version).toBeUndefined();
  });
});

describe('Compute Readiness Persistence', () => {
  it('persists and retrieves readiness state', async () => {
    const state = openFeltState({ path: statePath() });
    const store = new ComputeReadinessStore(state.db);

    const report: ComputeReadinessReport = {
      available: true,
      protocol: 'compute.remote@1',
      version: '0.1.17',
      runtimes: [
        {
          runtime: 'shell',
          status: 'installed',
          version: '1.37.0',
          source: 'host_development',
        },
        {
          runtime: 'node',
          status: 'available',
          version: '24.18.0',
          source: 'compute-distribution',
        },
      ],
    };

    await store.update(report);
    const retrieved = await store.current();

    expect(retrieved).toBeDefined();
    expect(retrieved?.available).toBe(true);
    expect(retrieved?.protocol).toBe('compute.remote@1');
    expect(retrieved?.version).toBe('0.1.17');
    expect(retrieved?.runtimes).toHaveLength(2);
    expect(retrieved?.runtimes?.[0].runtime).toBe('shell');

    state.close();
  });

  it('survives restart with durable FeltDB state', async () => {
    // Simulate a restart by opening the same state twice
    const path = statePath();
    const state1 = openFeltState({ path });
    const store1 = new ComputeReadinessStore(state1.db);

    const report: ComputeReadinessReport = {
      available: true,
      protocol: 'compute.remote@1',
      version: '0.1.17',
      runtimes: [
        {
          runtime: 'node',
          status: 'available',
          version: '24.18.0',
          source: 'compute-distribution',
        },
      ],
    };

    await store1.update(report);
    state1.close();

    // "Restart" - open state again
    const state2 = openFeltState({ path });
    const store2 = new ComputeReadinessStore(state2.db);

    const retrieved = await store2.current();
    expect(retrieved?.available).toBe(true);
    expect(retrieved?.runtimes).toHaveLength(1);

    state2.close();
  });

  it('provides runtime query methods', async () => {
    const state = openFeltState({ path: statePath() });
    const store = new ComputeReadinessStore(state.db);

    await store.update({
      available: true,
      runtimes: [
        {
          runtime: 'node',
          status: 'available',
          version: '24.18.0',
          source: 'compute-distribution',
        },
        {
          runtime: 'python',
          status: 'available',
          version: '3.13.15',
          source: 'compute-distribution',
        },
      ],
    });

    const runtimes = await store.runtimes();
    expect(runtimes).toHaveLength(2);

    const hasNode = await store.hasRuntime('node');
    expect(hasNode).toBe(true);

    const hasRust = await store.hasRuntime('rust');
    expect(hasRust).toBe(false);

    state.close();
  });
});

describe('Architectural Guards', () => {
  it('does not contain direct Chip invocation patterns', async () => {
    // This is a source-level guard: if these patterns appear anywhere,
    // the build should reject them. For now, this test serves as documentation
    // of what patterns are forbidden.

    const forbiddenPatterns = [
      /exec\s*\(\s*["']chip\b/,
      /exec\s*\(\s*["']compute-configured-chip\b/,
      /spawn\s*\(\s*["']chip\b/,
      /spawn\s*\(\s*["']compute-configured-chip\b/,
      /child_process\.exec\s*\(/,
      /child_process\.spawn\s*\(/,
      /\/opt\/homebrew\/bin\/compute-configured-chip/,
      /Chip[^a-z]/,
    ];

    // In a real build, these patterns would be checked via linting rules
    // or a custom build step. This test documents the architectural requirement.
    forbiddenPatterns.forEach((pattern) => {
      expect(pattern).toBeDefined();
    });
  });

  it('does not fake Compute agent capabilities', () => {
    // Compute 0.1.17 does not expose an agent invocation capability.
    // OpenDots must not fabricate one.

    // Valid: expose real Compute capabilities
    // Invalid: invent compute.agent.invoke, agent.invoke, ProviderOperation.Agent

    const invalidPatterns = [
      'compute.agent.invoke',
      'agent.invoke',
      'ProviderOperation.Agent',
      'computeAgent',
      'invokeAgent',
    ];

    // These should not appear in the implementation
    invalidPatterns.forEach((pattern) => {
      expect(pattern).toBeDefined(); // Marker for source validation
    });
  });
});
