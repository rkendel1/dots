import type { SetupStatus } from '../shared/types.js';
export interface PlatformConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
  computeEndpoint?: string;
  intelligenceProvider?: 'openai' | 'anthropic';
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  // Determine which provider is selected
  let intelligenceProvider: 'openai' | 'anthropic' | undefined;
  let intelligenceConfigured = false;

  // Check if OpenAI is the configured provider
  if (config.intelligenceProvider === 'openai' || (!config.intelligenceProvider && config.apiKey && config.model)) {
    intelligenceProvider = 'openai';
    intelligenceConfigured = !!(config.apiKey && config.model);
  } else if (config.intelligenceProvider === 'anthropic') {
    intelligenceProvider = 'anthropic';
    intelligenceConfigured = !!config.intelligenceKey;
  }

  // Build missing fields list: only include provider-specific requirements if that provider is selected
  const missing = [
    !config.intelligenceKey && config.intelligenceProvider === 'anthropic' && 'INTELLIGENCE_API_KEY',
    !config.apiKey && config.intelligenceProvider === 'openai' && 'OPENAI_API_KEY',
    !config.model && config.intelligenceProvider === 'openai' && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);

  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';

  return {
    intelligence: intelligenceConfigured,
    intelligenceProvider,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: intelligenceConfigured && !!(config.voiceKey && config.voiceModel),
    slack,
    missing,
  };
}
