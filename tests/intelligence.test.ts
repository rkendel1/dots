import { afterEach, expect, it, vi } from 'vitest';
import {
  bootstrapSettings,
  EnvironmentCredentials,
  IntelligenceService,
  type AdapterFactory,
  type CredentialResolver,
  type IntelligenceSettings,
} from '../src/server/intelligence.js';
import { ConfigurationService } from '../src/server/configuration.js';
import { memoryStore, type OpenStore } from './helpers/store.js';

const handles: OpenStore[] = [];
afterEach(() => handles.splice(0).forEach((handle) => handle.close()));

function recordingFactory() {
  const calls: { model: string; baseURL: string; apiKey: string }[] = [];
  const factory: AdapterFactory = (model, options) => {
    calls.push({ model, ...options });
    return {} as ReturnType<AdapterFactory>;
  };
  return { calls, factory };
}

function serviceWith(
  saved: () => IntelligenceSettings | undefined,
  env: NodeJS.ProcessEnv,
  bootstrap: IntelligenceSettings = {},
) {
  const { calls, factory } = recordingFactory();
  const service = new IntelligenceService(
    { savedIntelligenceSettings: async () => saved() },
    new EnvironmentCredentials(env),
    bootstrap,
    factory,
  );
  return { service, calls };
}

it('calls OpenAI through the shared OpenAI-compatible interface', async () => {
  const { service, calls } = serviceWith(
    () => ({ provider: 'openai', model: 'gpt-4.1-mini' }),
    { OPENAI_API_KEY: 'openai-key' },
  );
  await service.resolveModel();
  expect(calls).toEqual([
    {
      model: 'gpt-4.1-mini',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'openai-key',
    },
  ]);
});

it('calls Anthropic through its OpenAI-compatible endpoint with its own credential', async () => {
  const { service, calls } = serviceWith(
    () => ({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
    { ANTHROPIC_API_KEY: 'anthropic-key', OPENAI_API_KEY: 'wrong-key' },
  );
  await service.resolveModel();
  expect(calls).toEqual([
    {
      model: 'claude-haiku-4-5',
      baseURL: 'https://api.anthropic.com/v1/',
      apiKey: 'anthropic-key',
    },
  ]);
});

it('does not need the CopilotKit hosted-service key for inference', async () => {
  const { service } = serviceWith(
    () => ({ provider: 'openai', model: 'gpt-4.1-mini' }),
    { OPENAI_API_KEY: 'openai-key' },
  );
  expect((await service.status()).ready).toBe(true);
  // ...and that key alone does not make Intelligence ready.
  const hostedOnly = serviceWith(
    () => ({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
    { INTELLIGENCE_API_KEY: 'copilotkit-hosted-key' },
  ).service;
  await expect(hostedOnly.resolveModel()).rejects.toThrow('ANTHROPIC_API_KEY');
});

it('applies a changed Setup configuration to the very next request', async () => {
  let saved: IntelligenceSettings = {
    provider: 'openai',
    model: 'first-model',
  };
  const { service, calls } = serviceWith(() => saved, {
    OPENAI_API_KEY: 'openai-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
  });
  await service.resolveModel();
  saved = { provider: 'anthropic', model: 'second-model' };
  await service.resolveModel();
  expect(calls.map(({ model, apiKey }) => [model, apiKey])).toEqual([
    ['first-model', 'openai-key'],
    ['second-model', 'anthropic-key'],
  ]);
});

it('uses saved Setup values before environment bootstrap values', async () => {
  const handle = memoryStore();
  handles.push(handle);
  const env = {
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'env-model',
    ANTHROPIC_API_KEY: 'anthropic-key',
  };
  const configuration = new ConfigurationService(
    handle.state.db,
    'owner',
    new EnvironmentCredentials(env),
    bootstrapSettings(env),
  );
  const { calls, factory } = recordingFactory();
  const service = new IntelligenceService(
    configuration,
    configuration.credentials,
    bootstrapSettings(env),
    factory,
  );
  // Before Setup saves anything, the environment bootstraps a working OpenAI config.
  await service.resolveModel();
  await configuration.saveConfiguration({
    intelligence: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  });
  await service.resolveModel();
  expect(calls.map(({ model, baseURL }) => [model, baseURL])).toEqual([
    ['env-model', 'https://api.openai.com/v1'],
    ['claude-haiku-4-5', 'https://api.anthropic.com/v1/'],
  ]);
});

it('only ever obtains the credential through the credential resolver', async () => {
  const withCredential = vi.fn(
    <T>(_provider: string, use: (credential: string) => T) => use('scoped-key'),
  );
  const resolver: CredentialResolver = {
    has: () => true,
    withCredential: withCredential as CredentialResolver['withCredential'],
  };
  const { calls, factory } = recordingFactory();
  const service = new IntelligenceService(
    {
      savedIntelligenceSettings: async () => ({
        provider: 'openai',
        model: 'm',
      }),
    },
    resolver,
    {},
    factory,
  );
  const resolved = await service.resolveModel();
  expect(withCredential).toHaveBeenCalledWith('openai', expect.any(Function));
  expect(calls[0]!.apiKey).toBe('scoped-key');
  expect(JSON.stringify(resolved)).not.toContain('scoped-key');
  expect(JSON.stringify(await service.status())).not.toContain('scoped-key');
});

it('reports what is missing instead of guessing a provider', async () => {
  const { service } = serviceWith(() => undefined, {});
  expect(await service.status()).toMatchObject({
    ready: false,
    missing: ['Intelligence provider', 'Intelligence model'],
  });
  await expect(service.resolveModel()).rejects.toThrow(
    'Intelligence setup required',
  );
});

it('never sends a provider key to a base URL configured for a different provider', async () => {
  const env = {
    OPENAI_API_KEY: 'openai-key',
    OPENAI_MODEL: 'gpt-4.1-mini',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    ANTHROPIC_API_KEY: 'anthropic-key',
  };
  const { calls, factory } = recordingFactory();
  const service = new IntelligenceService(
    {
      savedIntelligenceSettings: async () => ({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    },
    new EnvironmentCredentials(env),
    bootstrapSettings(env),
    factory,
  );
  await service.resolveModel();
  expect(calls).toEqual([
    {
      model: 'claude-haiku-4-5',
      baseURL: 'https://api.anthropic.com/v1/',
      apiKey: 'anthropic-key',
    },
  ]);
  // An OpenAI model name is not borrowed for Anthropic either.
  const unsavedModel = new IntelligenceService(
    { savedIntelligenceSettings: async () => ({ provider: 'anthropic' }) },
    new EnvironmentCredentials(env),
    bootstrapSettings(env),
    factory,
  );
  expect((await unsavedModel.status()).missing).toEqual(['Intelligence model']);
});
