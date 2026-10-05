import { expect, it } from 'vitest';
import {
  setupStatus,
  type PlatformConfig,
} from '../src/server/platform-config.js';
const config: PlatformConfig = {
  intelligenceKey: 'fixture',
  apiKey: 'fixture',
  model: 'fixture',
  baseUrl: 'https://example.com',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
};
it('never claims Slack online without a complete managed channel declaration', () => {
  expect(setupStatus(config, 'online').slack).toBe('not_configured');
  expect(
    setupStatus({ ...config, slackChannel: 'support' }, 'online').slack,
  ).toBe('setup_required');
  expect(
    setupStatus(
      {
        ...config,
        slackChannel: 'support',
        slackTeam: 'team',
        slackUsers: ['owner'],
      },
      'online',
    ).slack,
  ).toBe('online');
});
it('disables voice when Intelligence provider is not configured', () => {
  // Without any intelligence provider configured
  expect(
    setupStatus({
      ...config,
      apiKey: '',
      model: '',
      intelligenceKey: '',
      voiceKey: 'fixture',
      voiceModel: 'fixture',
    }),
  ).toMatchObject({ intelligence: false, voice: false });
});

it('supports provider-agnostic intelligence configuration', () => {
  // OpenAI provider explicitly configured
  expect(
    setupStatus({
      ...config,
      intelligenceProvider: 'openai',
      apiKey: 'sk-...',
      model: 'gpt-4',
    }),
  ).toMatchObject({
    intelligence: true,
    intelligenceProvider: 'openai',
    missing: [],
  });
});

it('supports alternative intelligence providers', () => {
  // Anthropic provider configured
  expect(
    setupStatus({
      ...config,
      intelligenceProvider: 'anthropic',
      intelligenceKey: 'claude-...',
      apiKey: '',
      model: '',
    }),
  ).toMatchObject({
    intelligence: true,
    intelligenceProvider: 'anthropic',
  });
});
it('reports activation failure until the SDK recovers online', () => {
  const declared = {
    ...config,
    slackChannel: 'support',
    slackTeam: 'team',
    slackUsers: ['owner'],
  };
  expect(setupStatus(declared, 'offline', true).slack).toBe(
    'activation_failed',
  );
  expect(setupStatus(declared, 'online', true).slack).toBe('online');
});
