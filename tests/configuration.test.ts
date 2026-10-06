import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationService } from '../src/server/configuration.js';
import { configurationRoutes } from '../src/server/configuration-routes.js';
import { EnvironmentCredentials } from '../src/server/intelligence.js';
import { fileStore, memoryStore, type OpenStore } from './helpers/store.js';
import type { PlatformConfig } from '../src/server/platform-config.js';

const SECRET = 'sk-test-SECRET-VALUE-0123456789';
const handles: OpenStore[] = [];
const dirs: string[] = [];

const env = { ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: SECRET };
const credentials = () => new EnvironmentCredentials(env);

function openConfig(ownerId = 'test-owner', bootstrap = {}) {
  const handle = memoryStore();
  handles.push(handle);
  return new ConfigurationService(
    handle.state.db,
    ownerId,
    credentials(),
    bootstrap,
  );
}

function durableDir() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-config-'));
  dirs.push(dir);
  return dir;
}

function openAt(dir: string, ownerId = 'test-owner') {
  const handle = fileStore(join(dir, 'state'));
  handles.push(handle);
  return {
    service: new ConfigurationService(
      handle.state.db,
      ownerId,
      credentials(),
      {},
    ),
    handle,
  };
}

const platformConfig: PlatformConfig = {
  voiceName: 'marin',
  runtimeUrl: 'http://localhost:4310/api/copilotkit',
};

/** Every file under `dir`, concatenated, so a test can grep durable state. */
function rawState(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    out += statSync(path).isDirectory()
      ? rawState(path)
      : readFileSync(path, 'latin1');
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('Intelligence configuration', () => {
  it('is incomplete until a provider and model are saved', async () => {
    const config = await openConfig().getConfiguration(platformConfig);
    expect(config.setupComplete).toBe(false);
    expect(
      config.requirements.find((r) => r.id === 'intelligence')?.configured,
    ).toBe(false);
  });

  it('becomes complete from Setup alone, without any model setting in the environment', async () => {
    const service = openConfig();
    await service.saveConfiguration({
      intelligence: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    const config = await service.getConfiguration(platformConfig);
    expect(config.setupComplete).toBe(true);
    expect(config.sections.intelligence).toMatchObject({
      configured: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      credentialVariable: 'ANTHROPIC_API_KEY',
      apiKey: { configured: true },
    });
  });

  it('lets saved Setup values override environment bootstrap values field by field', async () => {
    const service = openConfig('owner', {
      provider: 'openai',
      model: 'env-model',
      baseUrl: 'https://env.invalid/v1',
    });
    expect(await service.savedIntelligenceSettings()).toBeUndefined();
    await service.saveConfiguration({ intelligence: { model: 'setup-model' } });
    const config = await service.getConfiguration(platformConfig);
    // Saved model wins; provider still comes from bootstrap because Setup left it unset.
    expect(config.sections.intelligence.model).toBe('setup-model');
    expect(config.sections.intelligence.provider).toBe('openai');
  });

  it('reports a missing provider credential by variable name only', async () => {
    const handle = memoryStore();
    handles.push(handle);
    const service = new ConfigurationService(
      handle.state.db,
      'owner',
      new EnvironmentCredentials({
        INTELLIGENCE_API_KEY: 'copilotkit-hosted-key',
      }),
      {},
    );
    await service.saveConfiguration({
      intelligence: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    const config = await service.getConfiguration(platformConfig);
    expect(config.setupComplete).toBe(false);
    expect(
      config.requirements.find((r) => r.id === 'intelligence_credential'),
    ).toMatchObject({ configured: false, label: 'Anthropic credential' });
  });

  it('persists configuration across a restart', async () => {
    const dir = durableDir();
    const first = openAt(dir);
    await first.service.saveConfiguration({
      intelligence: { provider: 'openai', model: 'gpt-4.1-mini' },
    });
    first.handle.close();
    const second = openAt(dir);
    expect(await second.service.savedIntelligenceSettings()).toEqual({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      baseUrl: undefined,
    });
  });

  it("keeps each owner's configuration separate", async () => {
    const handle = memoryStore();
    handles.push(handle);
    const a = new ConfigurationService(
      handle.state.db,
      'owner-a',
      credentials(),
      {},
    );
    const b = new ConfigurationService(
      handle.state.db,
      'owner-b',
      credentials(),
      {},
    );
    await a.saveConfiguration({
      intelligence: { provider: 'openai', model: 'a-model' },
    });
    expect(
      (await a.getConfiguration(platformConfig)).sections.intelligence.model,
    ).toBe('a-model');
    expect(
      (await b.getConfiguration(platformConfig)).sections.intelligence.model,
    ).toBeUndefined();
  });
});

describe('credential custody', () => {
  async function routes(service: ConfigurationService) {
    return configurationRoutes(service, platformConfig);
  }

  it('never returns a credential from the configuration or capability APIs', async () => {
    const service = openConfig();
    await service.saveConfiguration({
      intelligence: { provider: 'openai', model: 'gpt-4.1-mini' },
    });
    const app = await routes(service);
    for (const path of ['/configuration', '/setup/capabilities']) {
      const body = await (await app.request(path)).text();
      expect(body).not.toContain(SECRET);
    }
  });

  it('rejects a configuration write that carries a credential', async () => {
    const service = openConfig();
    const response = await (
      await routes(service)
    ).request('/configuration', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intelligence: { provider: 'openai', model: 'm', apiKey: SECRET },
      }),
    });
    expect(response.status).toBe(400);
    expect(await service.savedIntelligenceSettings()).toBeUndefined();
  });

  it('stores no credential in durable configuration', async () => {
    const dir = durableDir();
    const { service, handle } = openAt(dir);
    await service.saveConfiguration({
      intelligence: { provider: 'openai', model: 'gpt-4.1-mini' },
    });
    handle.close();
    const raw = rawState(dir);
    expect(raw).toContain('gpt-4.1-mini');
    expect(raw).not.toContain(SECRET);
  });

  it('scrubs a plaintext credential written by an earlier build, without logging it', async () => {
    const dir = durableDir();
    const first = openAt(dir);
    // Simulate the earlier build's record shape directly.
    await first.handle.state.db.transaction((tx) => {
      tx.collection('configurations').set('legacy', {
        id: 'legacy',
        ownerId: 'test-owner',
        intelligence: {
          provider: 'anthropic',
          apiKey: SECRET,
          model: 'claude-haiku-4-5',
        },
        savedAt: 1,
        updatedAt: 1,
        __version: 1,
      });
    });
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ];
    expect(await first.service.scrubPlaintextCredentials()).toBe(1);
    expect(await first.service.scrubPlaintextCredentials()).toBe(0);
    expect(await first.service.savedIntelligenceSettings()).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    });
    for (const log of logs)
      expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
    first.handle.close();
    // The current value is gone; FeltDB's own history is outside this check.
    const reopened = openAt(dir);
    const records = await reopened.handle.state.db
      .collection('configurations')
      .all();
    expect(JSON.stringify(records)).not.toContain(SECRET);
  });
});
