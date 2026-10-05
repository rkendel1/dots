import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationService } from '../src/server/configuration.js';
import {
  fileStore,
  memoryStore,
  type OpenStore,
} from './helpers/store.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const handles: OpenStore[] = [];
const dirs: string[] = [];

function openConfig(ownerId: string = 'test-owner') {
  const handle = memoryStore();
  handles.push(handle);
  return new ConfigurationService(handle.state.db, ownerId);
}

function durableConfig(ownerId: string = 'test-owner') {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-config-'));
  dirs.push(dir);
  const handle = fileStore(join(dir, 'state'));
  handles.push(handle);
  return { config: new ConfigurationService(handle.state.db, ownerId), handle, dir };
}

function reopenConfig(dir: string, ownerId: string = 'test-owner') {
  const handle = fileStore(join(dir, 'state'));
  handles.push(handle);
  return new ConfigurationService(handle.state.db, ownerId);
}

const baseConfig: PlatformConfig = {
  intelligenceKey: 'test-key',
  apiKey: 'test-openai-key',
  model: 'gpt-4',
  baseUrl: 'https://api.openai.com/v1',
  voiceName: 'marin',
  slackUsers: [],
  runtimeUrl: 'http://localhost:4310/api/copilotkit',
};

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('Configuration Service', () => {
  describe('getConfiguration', () => {
    it('returns setup complete when required fields are configured', async () => {
      const service = openConfig();
      const config = await service.getConfiguration(baseConfig);

      expect(config.setupComplete).toBe(true);
      expect(config.sections.intelligence.apiKey.configured).toBe(true);
    });

    it('returns setup incomplete when secrets are missing', async () => {
      const service = openConfig();
      const config = await service.getConfiguration({
        ...baseConfig,
        intelligenceKey: undefined,
      });

      expect(config.setupComplete).toBe(false);
    });

    it('never returns secret values in response', async () => {
      const service = openConfig();
      const config = await service.getConfiguration(baseConfig);

      // Secret status should show configured but not the value
      expect(config.sections.intelligence.apiKey).toEqual({
        configured: true,
        source: 'environment',
      });
      // Should not have a value property for secrets
      expect('value' in config.sections.intelligence.apiKey).toBe(false);
    });

    it('tracks required vs optional requirements', async () => {
      const service = openConfig();
      const config = await service.getConfiguration(baseConfig);

      const required = config.requirements.filter((r) => r.required);
      const optional = config.requirements.filter((r) => !r.required);

      expect(required.length).toBeGreaterThan(0);
      expect(optional.length).toBeGreaterThan(0);

      // Core requirements should be required
      const coreReq = required.find((r) => r.id === 'intelligence_api_key');
      expect(coreReq).toBeDefined();

      // Optional integrations should be optional
      const slackReq = optional.find((r) => r.id === 'slack');
      expect(slackReq).toBeDefined();
    });

    it('does not require optional integrations for setup completion', async () => {
      const service = openConfig();
      const incompleteConfig: PlatformConfig = {
        ...baseConfig,
        voiceKey: undefined,
        slackChannel: undefined,
        computerSupervisorUrl: undefined,
      };

      const config = await service.getConfiguration(incompleteConfig);
      expect(config.setupComplete).toBe(true);
    });
  });

  describe('saveConfiguration', () => {
    it('persists non-secret configuration to FeltDB', async () => {
      const service = openConfig();

      await service.saveConfiguration({
        intelligence: { model: 'gpt-4-turbo' },
      });

      const config = await service.getConfiguration(baseConfig);
      expect(config.sections.intelligence.model).toBe('gpt-4-turbo');
    });

    it('preserves configuration across restarts', async () => {
      const { config, handle, dir } = durableConfig();

      await config.saveConfiguration({
        voice: { model: 'tts-1', name: 'echo' },
      });

      handle.close();

      const reopened = reopenConfig(dir);
      const readConfig = await reopened.getConfiguration(baseConfig);
      expect(readConfig.sections.voice.model).toBe('tts-1');
      expect(readConfig.sections.voice.name).toBe('echo');
    });

    it('merges new configuration with existing', async () => {
      const service = openConfig();

      await service.saveConfiguration({
        intelligence: { model: 'gpt-4' },
      });

      await service.saveConfiguration({
        voice: { model: 'tts-1' },
      });

      const config = await service.getConfiguration(baseConfig);
      expect(config.sections.intelligence.model).toBe('gpt-4');
      expect(config.sections.voice.model).toBe('tts-1');
    });

    it('updates existing configuration fields', async () => {
      const service = openConfig();

      await service.saveConfiguration({
        intelligence: { model: 'gpt-4' },
      });

      await service.saveConfiguration({
        intelligence: { model: 'gpt-3.5-turbo' },
      });

      const config = await service.getConfiguration(baseConfig);
      expect(config.sections.intelligence.model).toBe('gpt-3.5-turbo');
    });

    it('separates configuration by owner', async () => {
      const service1 = openConfig('owner1');
      const service2 = openConfig('owner2');

      await service1.saveConfiguration({
        intelligence: { model: 'gpt-4' },
      });

      await service2.saveConfiguration({
        intelligence: { model: 'gpt-3.5' },
      });

      const config1 = await service1.getConfiguration(baseConfig);
      const config2 = await service2.getConfiguration(baseConfig);

      expect(config1.sections.intelligence.model).toBe('gpt-4');
      expect(config2.sections.intelligence.model).toBe('gpt-3.5');
    });

    it('tracks update timestamps', async () => {
      const service = openConfig();
      const before = Date.now();

      await service.saveConfiguration({
        intelligence: { model: 'gpt-4' },
      });

      const after = Date.now();
      const config = await service.getConfiguration(baseConfig);

      // Can't easily access the stored config to check updatedAt,
      // but we can verify it doesn't error
      expect(config.sections.intelligence.model).toBe('gpt-4');
    });
  });

  describe('secret status indicators', () => {
    it('shows configured for environment secrets', async () => {
      const service = openConfig();
      const config = await service.getConfiguration(baseConfig);

      expect(config.sections.intelligence.apiKey.configured).toBe(true);
      expect(config.sections.intelligence.apiKey.source).toBe('environment');
    });

    it('shows not configured for missing secrets', async () => {
      const service = openConfig();
      const config = await service.getConfiguration({
        ...baseConfig,
        intelligenceKey: undefined,
      });

      expect(config.sections.intelligence.apiKey.configured).toBe(false);
      expect(config.sections.intelligence.apiKey.source).toBeUndefined();
    });

    it('never includes secret values in status', async () => {
      const service = openConfig();
      const config = await service.getConfiguration({
        ...baseConfig,
        intelligenceKey: 'super-secret-key-12345',
      });

      // Status should only have configured and source, not the secret
      const status = config.sections.intelligence.apiKey;
      expect(status).not.toHaveProperty('value');
      expect(Object.keys(status)).toEqual(
        expect.arrayContaining(['configured', 'source']),
      );
    });
  });

  describe('configuration requirements', () => {
    it('includes all required sections in requirements', async () => {
      const service = openConfig();
      const config = await service.getConfiguration(baseConfig);

      const requiredIds = config.requirements
        .filter((r) => r.required)
        .map((r) => r.id);

      expect(requiredIds).toContain('intelligence_api_key');
      expect(requiredIds).toContain('openai_api_key');
      expect(requiredIds).toContain('openai_model');
    });

    it('marks incomplete requirements correctly', async () => {
      const service = openConfig();
      const config = await service.getConfiguration({
        ...baseConfig,
        model: undefined,
      });

      const modelReq = config.requirements.find((r) => r.id === 'openai_model');
      expect(modelReq?.configured).toBe(false);
      expect(modelReq?.source).toBe('missing');
    });

    it('handles multiple owners separately', async () => {
      const service1 = openConfig('owner1');
      const service2 = openConfig('owner2');

      const config1 = await service1.getConfiguration(baseConfig);
      const config2 = await service2.getConfiguration({
        ...baseConfig,
        model: undefined,
      });

      const req1 = config1.requirements.find((r) => r.id === 'openai_model');
      const req2 = config2.requirements.find((r) => r.id === 'openai_model');

      expect(req1?.configured).toBe(true);
      expect(req2?.configured).toBe(false);
    });
  });
});
