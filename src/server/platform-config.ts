import type { SetupStatus } from '../shared/types.js';
import type { IntelligenceStatus } from './intelligence.js';

/**
 * Process-level configuration read from the environment at startup.
 *
 * Intelligence (provider, model, credential) is deliberately not here: it is
 * resolved per request by `IntelligenceService` from durable Setup configuration.
 */
export interface PlatformConfig {
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  runtimeUrl: string;
  ownerToken?: string;
  computeEndpoint?: string;
}

export function setupStatus(
  config: PlatformConfig,
  intelligence: IntelligenceStatus,
): SetupStatus {
  return {
    intelligence: intelligence.ready,
    intelligenceProvider: intelligence.provider,
    browser: !!(config.browserUrl && config.browserSecret),
    voice: intelligence.ready && !!(config.voiceKey && config.voiceModel),
    missing: intelligence.missing,
  };
}
