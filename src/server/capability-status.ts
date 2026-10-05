/**
 * Capability-oriented status model for OpenDots Setup.
 *
 * Transforms detailed configuration into a capability-focused view.
 * Users see what OpenDots can do, not how infrastructure happens to implement it.
 *
 * Capabilities:
 * - Intelligence (required)
 * - Computers (optional, Compute-backed)
 * - Browser (optional)
 * - Voice (optional, requires Intelligence)
 * - Slack (optional)
 */

import type { ComputeReadinessRecord } from './compute-readiness-store.js';
import type { ConfigurationReadModel } from '../shared/types.js';
import type { PlatformConfig } from './platform-config.js';

export interface CapabilityStatus {
  status: 'ready' | 'configured' | 'not_configured' | 'error';
  reason?: string;
}

export interface IntelligenceCapability extends CapabilityStatus {
  required: true;
  provider?: 'openai' | 'anthropic';
  model?: string;
  credentialConfigured: boolean;
}

export interface ComputeCapability extends CapabilityStatus {
  required: false;
  capabilities?: string[];
  endpoint?: string;
}

export interface BrowserCapability extends CapabilityStatus {
  required: false;
  url?: string;
}

export interface VoiceCapability extends CapabilityStatus {
  required: false;
  provider?: string;
  model?: string;
  voice?: string;
  credentialConfigured: boolean;
}

export interface SlackCapability extends CapabilityStatus {
  required: false;
  channel?: string;
  team?: string;
}

export interface SetupCapabilitiesModel {
  intelligence: IntelligenceCapability;
  computers: ComputeCapability;
  browser: BrowserCapability;
  voice: VoiceCapability;
  slack: SlackCapability;
}

/**
 * Build capability status from configuration.
 *
 * Derives capability state from the existing configuration without inventing
 * infrastructure details or making assumptions about implementation.
 */
export function buildCapabilityStatus(
  config: ConfigurationReadModel,
  computeState: ComputeReadinessRecord | undefined,
): SetupCapabilitiesModel {
  // Intelligence: required capability
  const intelligenceSection = config.sections.intelligence;
  const intelligence: IntelligenceCapability = {
    required: true,
    status: intelligenceSection.configured ? 'ready' : 'not_configured',
    provider: intelligenceSection.provider as 'openai' | 'anthropic' | undefined,
    model: intelligenceSection.model,
    credentialConfigured: intelligenceSection.apiKey.configured,
  };

  // Computers: optional Compute-backed capability
  const computeSection = config.sections.compute;
  const computerCapabilities: string[] = [];

  if (computeState?.available && computeState?.runtimes) {
    // Only report capabilities that Compute actually advertises
    computerCapabilities.push('workload execution');
    // Add more capabilities as Compute reports them
  }

  const computers: ComputeCapability = {
    required: false,
    status: computeSection.available ? 'ready' : 'not_configured',
    capabilities: computerCapabilities.length > 0 ? computerCapabilities : undefined,
    endpoint: computeSection.endpoint,
    reason: computeSection.error,
  };

  // Browser: optional capability
  const browserSection = config.sections.browser;
  const browser: BrowserCapability = {
    required: false,
    status: browserSection.url ? 'ready' : 'not_configured',
    url: browserSection.url,
  };

  // Voice: optional capability (requires Intelligence)
  const voiceSection = config.sections.voice;
  const voice: VoiceCapability = {
    required: false,
    status: intelligenceSection.configured && voiceSection.model ? 'ready' : 'not_configured',
    model: voiceSection.model,
    voice: voiceSection.name,
    credentialConfigured: voiceSection.apiKey.configured,
    reason: !intelligenceSection.configured ? 'requires Intelligence capability' : undefined,
  };

  // Slack: optional capability
  const slackSection = config.sections.slack;
  const slack: SlackCapability = {
    required: false,
    status: slackSection.channelName && slackSection.teamId ? 'ready' : 'not_configured',
    channel: slackSection.channelName,
    team: slackSection.teamId,
  };

  return {
    intelligence,
    computers,
    browser,
    voice,
    slack,
  };
}

/**
 * Check if setup is capability-complete.
 *
 * All required capabilities must be ready.
 */
export function isSetupCapabilityComplete(capabilities: SetupCapabilitiesModel): boolean {
  return capabilities.intelligence.status === 'ready';
}
