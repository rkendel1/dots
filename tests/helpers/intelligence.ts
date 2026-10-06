import {
  EnvironmentCredentials,
  IntelligenceService,
  type IntelligenceSettings,
} from '../../src/server/intelligence.js';

/**
 * An IntelligenceService over fixed settings and a fake environment, so a test
 * controls provider, model and credential without touching `process.env`.
 */
export function fixedIntelligence(
  settings: IntelligenceSettings = {
    provider: 'openai',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
  },
  env: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: 'fixture',
    ANTHROPIC_API_KEY: 'fixture',
  },
) {
  return new IntelligenceService(
    { savedIntelligenceSettings: async () => settings },
    new EnvironmentCredentials(env),
    {},
  );
}

export const testPlatformConfig = {
  runtimeUrl: '',
  voiceName: 'marin',
};
