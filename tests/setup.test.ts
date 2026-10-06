import { expect, it } from 'vitest';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
import {
  EnvironmentCredentials,
  intelligenceStatus,
} from '../src/server/intelligence.js';

const config: PlatformConfig = {
  runtimeUrl: '',
  voiceName: 'marin',
  voiceKey: 'fixture',
  voiceModel: 'fixture',
};
const credentials = new EnvironmentCredentials({
  OPENAI_API_KEY: 'fixture',
  ANTHROPIC_API_KEY: 'fixture',
});

it('disables voice when no Intelligence provider is configured', () => {
  const status = setupStatus(config, intelligenceStatus({}, credentials));
  expect(status).toMatchObject({ intelligence: false, voice: false });
  expect(status.missing).toEqual([
    'Intelligence provider',
    'Intelligence model',
  ]);
});

it('reports OpenAI as ready with a model and a credential', () => {
  expect(
    setupStatus(
      config,
      intelligenceStatus(
        { provider: 'openai', model: 'gpt-4.1-mini' },
        credentials,
      ),
    ),
  ).toMatchObject({
    intelligence: true,
    intelligenceProvider: 'openai',
    voice: true,
    missing: [],
  });
});

it('reports Anthropic as ready through its own credential, not a CopilotKit key', () => {
  const anthropicOnly = new EnvironmentCredentials({
    ANTHROPIC_API_KEY: 'fixture',
  });
  expect(
    setupStatus(
      config,
      intelligenceStatus(
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        anthropicOnly,
      ),
    ),
  ).toMatchObject({
    intelligence: true,
    intelligenceProvider: 'anthropic',
    missing: [],
  });
});

it('names the missing provider credential variable without exposing anything else', () => {
  const none = new EnvironmentCredentials({
    INTELLIGENCE_API_KEY: 'copilotkit-hosted-key',
  });
  const status = setupStatus(
    config,
    intelligenceStatus(
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      none,
    ),
  );
  expect(status.intelligence).toBe(false);
  expect(status.missing).toEqual(['ANTHROPIC_API_KEY']);
});
