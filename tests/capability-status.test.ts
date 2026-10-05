/**
 * Tests for capability-oriented Setup model.
 *
 * Verifies that the Setup UI presents capabilities, not implementation details.
 */

import { describe, it, expect } from 'vitest';
import { buildCapabilityStatus } from '../src/server/capability-status.js';
import type { ConfigurationReadModel } from '../src/shared/types.js';
import type { ComputeReadinessRecord } from '../src/server/compute-readiness-store.js';

// Mock configuration with minimal setup
function mockConfiguration(overrides?: Partial<ConfigurationReadModel>): ConfigurationReadModel {
  return {
    setupComplete: false,
    sections: {
      core: {
        appOrigin: undefined,
        ownerToken: { configured: false },
      },
      intelligence: {
        configured: false,
        provider: undefined,
        apiUrl: undefined,
        wsUrl: undefined,
        apiKey: { configured: false },
        model: undefined,
        baseUrl: undefined,
      },
      browser: {
        url: undefined,
        host: undefined,
        port: undefined,
        secret: { configured: false },
      },
      voice: {
        model: undefined,
        name: undefined,
        apiKey: { configured: false },
      },
      slack: {
        channelName: undefined,
        teamId: undefined,
        userIds: [],
        dotId: undefined,
      },
      computers: {
        supervisorToken: { configured: false },
        token: { configured: false },
        namespace: undefined,
        memoryBytes: undefined,
        runtime: undefined,
        engineSocket: undefined,
      },
      compute: {
        endpoint: undefined,
        available: false,
        protocol: undefined,
        version: undefined,
        runtimes: [],
        error: undefined,
      },
    },
    requirements: [],
    ...overrides,
  };
}

describe('Capability Status', () => {
  it('reports Intelligence as not configured when provider is absent', () => {
    const config = mockConfiguration();
    const capabilities = buildCapabilityStatus(config, undefined);

    expect(capabilities.intelligence).toMatchObject({
      required: true,
      status: 'not_configured',
      provider: undefined,
    });
  });

  it('reports Intelligence as ready when OpenAI is configured', () => {
    const config = mockConfiguration({
      sections: {
        ...mockConfiguration().sections,
        intelligence: {
          configured: true,
          provider: 'openai',
          apiUrl: undefined,
          wsUrl: undefined,
          apiKey: { configured: true },
          model: 'gpt-4',
          baseUrl: undefined,
        },
      },
    });

    const capabilities = buildCapabilityStatus(config, undefined);
    expect(capabilities.intelligence).toMatchObject({
      required: true,
      status: 'ready',
      provider: 'openai',
      model: 'gpt-4',
      credentialConfigured: true,
    });
  });

  it('reports Computers as not connected when Compute is unavailable', () => {
    const config = mockConfiguration();
    const capabilities = buildCapabilityStatus(config, undefined);

    expect(capabilities.computers).toMatchObject({
      required: false,
      status: 'not_configured',
    });
  });

  it('reports Computers as ready when Compute is available', () => {
    const config = mockConfiguration({
      sections: {
        ...mockConfiguration().sections,
        compute: {
          endpoint: 'http://localhost:9000',
          available: true,
          protocol: 'compute.remote@1',
          version: '0.1.17',
          runtimes: ['shell', 'node'],
          error: undefined,
        },
      },
    });

    const computeState: ComputeReadinessRecord = {
      id: 'current',
      available: true,
      protocol: 'compute.remote@1',
      version: '0.1.17',
      runtimes: [
        { runtime: 'shell', status: 'installed', version: '1.0', source: 'host' },
        { runtime: 'node', status: 'available', version: '24.0', source: 'compute' },
      ],
      checkedAt: Date.now(),
    };

    const capabilities = buildCapabilityStatus(config, computeState);
    expect(capabilities.computers).toMatchObject({
      required: false,
      status: 'ready',
      capabilities: ['workload execution'],
    });
  });

  it('reports Browser as ready when URL is configured', () => {
    const config = mockConfiguration({
      sections: {
        ...mockConfiguration().sections,
        browser: {
          url: 'http://localhost:4311',
          host: undefined,
          port: undefined,
          secret: { configured: true },
        },
      },
    });

    const capabilities = buildCapabilityStatus(config, undefined);
    expect(capabilities.browser).toMatchObject({
      required: false,
      status: 'ready',
      url: 'http://localhost:4311',
    });
  });

  it('reports Voice as not configured when Intelligence is absent', () => {
    const config = mockConfiguration({
      sections: {
        ...mockConfiguration().sections,
        voice: {
          model: 'some-voice-model',
          name: 'voice-name',
          apiKey: { configured: true },
        },
      },
    });

    const capabilities = buildCapabilityStatus(config, undefined);
    expect(capabilities.voice).toMatchObject({
      required: false,
      status: 'not_configured',
      reason: 'requires Intelligence capability',
    });
  });

  it('reports Voice as ready when Intelligence and Voice are configured', () => {
    const config = mockConfiguration({
      sections: {
        ...mockConfiguration().sections,
        intelligence: {
          configured: true,
          provider: 'openai',
          apiUrl: undefined,
          wsUrl: undefined,
          apiKey: { configured: true },
          model: 'gpt-4',
          baseUrl: undefined,
        },
        voice: {
          model: 'voice-model',
          name: 'voice-name',
          apiKey: { configured: true },
        },
      },
    });

    const capabilities = buildCapabilityStatus(config, undefined);
    expect(capabilities.voice).toMatchObject({
      required: false,
      status: 'ready',
      model: 'voice-model',
      voice: 'voice-name',
      credentialConfigured: true,
    });
  });

  it('reports Slack as ready when channel and team are configured', () => {
    const config = mockConfiguration({
      sections: {
        ...mockConfiguration().sections,
        slack: {
          channelName: '#opendots',
          teamId: 'T123456',
          userIds: ['U123456'],
          dotId: 'dot-123',
        },
      },
    });

    const capabilities = buildCapabilityStatus(config, undefined);
    expect(capabilities.slack).toMatchObject({
      required: false,
      status: 'ready',
      channel: '#opendots',
      team: 'T123456',
    });
  });

  it('never exposes secret values, only status', () => {
    const config = mockConfiguration({
      sections: {
        ...mockConfiguration().sections,
        intelligence: {
          configured: true,
          provider: 'openai',
          apiUrl: undefined,
          wsUrl: undefined,
          apiKey: { configured: true },
          model: 'gpt-4',
          baseUrl: undefined,
        },
      },
    });

    const capabilities = buildCapabilityStatus(config, undefined);

    // API key should never appear anywhere
    expect(JSON.stringify(capabilities)).not.toContain('sk-');
    expect(JSON.stringify(capabilities)).not.toContain('secret');
    expect(JSON.stringify(capabilities)).not.toContain('token');

    // Only status should appear
    expect(capabilities.intelligence.credentialConfigured).toBe(true);
  });

  it('omits capabilities that are not explicitly configured', () => {
    const config = mockConfiguration();
    const capabilities = buildCapabilityStatus(config, undefined);

    // Empty capabilities should not be present on Computers
    expect(capabilities.computers.capabilities).toBeUndefined();
  });
});
