import type { StateFirstDB } from '@feltdb/core';
import type {
  ConfigurationReadModel,
  ConfigurationRequirement,
  ManagedConfiguration,
  SecretStatus,
} from '../shared/types.js';
import { storeCollections, toConfiguration, type ConfigurationRecord } from './store-collections.js';
import type { PlatformConfig } from './platform-config.js';
import { ComputeReadinessStore } from './compute-readiness-store.js';

/**
 * Configuration service that manages the application's non-secret configuration.
 * Integrates environment variables with FeltDB-persisted managed configuration.
 *
 * Environment variables have precedence, allowing deployment-time bootstrap.
 * Managed configuration allows runtime UI changes for non-secret values.
 */
export class ConfigurationService {
  private db: StateFirstDB;
  private ownerId: string;
  private computeReadiness: ComputeReadinessStore;

  constructor(db: StateFirstDB, ownerId: string) {
    this.db = db;
    this.ownerId = ownerId;
    this.computeReadiness = new ComputeReadinessStore(db);
  }

  /**
   * Determine if a secret is configured via environment.
   * Used to show status without exposing the value.
   */
  private secretStatus(
    value: string | undefined,
  ): SecretStatus {
    return {
      configured: !!value,
      source: value ? 'environment' : undefined,
    };
  }

  /**
   * Get the current configuration read model.
   * Combines environment and managed configuration.
   */
  async getConfiguration(config: PlatformConfig): Promise<ConfigurationReadModel> {
    const managed = await this.getManagedConfiguration();
    const computeState = await this.computeReadiness.current();

    // Merge environment and managed configuration
    const merged: ConfigurationReadModel = {
      setupComplete: this.isSetupComplete(config),
      sections: {
        core: {
          ownerId: config.ownerToken ? 'configured' : undefined,
          appOrigin: managed?.appOrigin,
          ownerToken: this.secretStatus(config.ownerToken),
        },
        intelligence: {
          configured:
            !!(
              (config.apiKey && config.model) || config.intelligenceKey
            ),
          provider:
            config.intelligenceProvider === 'openai' ||
            (!config.intelligenceProvider && config.apiKey && config.model)
              ? 'openai'
              : config.intelligenceProvider === 'anthropic'
                ? 'anthropic'
                : undefined,
          apiUrl: managed?.intelligence?.apiUrl,
          wsUrl: managed?.intelligence?.wsUrl,
          apiKey: this.secretStatus(config.intelligenceKey),
          model: managed?.intelligence?.model,
          baseUrl: managed?.intelligence?.baseUrl,
        },
        browser: {
          url: managed?.browser?.url,
          host: managed?.browser?.host,
          port: managed?.browser?.port,
          secret: this.secretStatus(config.browserSecret),
        },
        voice: {
          model: managed?.voice?.model,
          name: managed?.voice?.name,
          apiKey: this.secretStatus(config.voiceKey),
        },
        slack: {
          channelName: managed?.slack?.channelName,
          teamId: managed?.slack?.teamId,
          userIds: managed?.slack?.userIds || [],
          dotId: managed?.slack?.dotId,
        },
        computers: {
          supervisorToken: this.secretStatus(config.computerSupervisorToken),
          token: this.secretStatus(config.computerToken),
          namespace: managed?.computers?.namespace,
          memoryBytes: managed?.computers?.memoryBytes,
          runtime: managed?.computers?.runtime,
          engineSocket: managed?.computers?.engineSocket,
        },
        compute: {
          endpoint: config.computeEndpoint,
          available: computeState?.available ?? false,
          protocol: computeState?.protocol,
          version: computeState?.version,
          runtimes: computeState?.runtimes?.map((r) => r.runtime) ?? [],
          error: computeState?.error,
        },
      },
      requirements: this.getRequirements(config),
    };

    return merged;
  }

  /**
   * Get configuration requirements for setup completion.
   * Defines which fields are required vs optional.
   *
   * Separates capability requirements (Intelligence) from provider choice (OpenAI, Anthropic, etc).
   * OpenDots requires an Intelligence capability, not a specific provider.
   */
  private getRequirements(config: PlatformConfig): ConfigurationRequirement[] {
    // Determine if OpenAI is explicitly selected or auto-detected
    const isOpenAISelected =
      config.intelligenceProvider === 'openai' ||
      (!config.intelligenceProvider && config.apiKey && config.model);

    const isAnthropicSelected = config.intelligenceProvider === 'anthropic';

    const requirements: ConfigurationRequirement[] = [
      // Intelligence capability is required, but no specific provider is
      {
        id: 'intelligence',
        section: 'intelligence' as const,
        label: 'Intelligence Provider',
        required: true,
        configured:
          (isOpenAISelected && !!config.apiKey && !!config.model) ||
          (isAnthropicSelected && !!config.intelligenceKey),
        valid:
          (isOpenAISelected && !!config.apiKey && !!config.model) ||
          (isAnthropicSelected && !!config.intelligenceKey),
        source:
          (config.apiKey && config.model) ||
          config.intelligenceKey
            ? 'environment'
            : 'missing',
      },
    ];

    // OpenAI is optional; only required if explicitly selected
    if (isOpenAISelected) {
      requirements.push(
        {
          id: 'openai_api_key',
          section: 'intelligence' as const,
          label: 'OpenAI API Key',
          required: true,
          configured: !!config.apiKey,
          valid: !!config.apiKey,
          source: config.apiKey ? 'environment' : 'missing',
        },
        {
          id: 'openai_model',
          section: 'intelligence' as const,
          label: 'OpenAI Model',
          required: true,
          configured: !!config.model,
          valid: !!config.model,
          source: config.model ? 'environment' : 'missing',
        },
      );
    }

    // Anthropic would be optional; only required if explicitly selected
    if (isAnthropicSelected) {
      requirements.push({
        id: 'anthropic_api_key',
        section: 'intelligence' as const,
        label: 'Anthropic API Key',
        required: true,
        configured: !!config.intelligenceKey,
        valid: !!config.intelligenceKey,
        source: config.intelligenceKey ? 'environment' : 'missing',
      });
    }

    // Optional integrations
    requirements.push(
      {
        id: 'browser',
        section: 'browser' as const,
        label: 'Browser Service',
        required: false,
        configured: !!(config.browserUrl && config.browserSecret),
        valid: !!(config.browserUrl && config.browserSecret),
        source:
          config.browserUrl && config.browserSecret ? 'environment' : 'missing',
      },
      {
        id: 'voice',
        section: 'voice' as const,
        label: 'Voice Service',
        required: false,
        configured: !!(config.voiceKey && config.voiceModel),
        valid: !!(config.voiceKey && config.voiceModel),
        source:
          config.voiceKey && config.voiceModel ? 'environment' : 'missing',
      },
      {
        id: 'slack',
        section: 'slack' as const,
        label: 'Slack Integration',
        required: false,
        configured: !!(
          config.slackChannel &&
          config.slackTeam &&
          config.slackUsers.length
        ),
        valid: !!(
          config.slackChannel &&
          config.slackTeam &&
          config.slackUsers.length
        ),
        source:
          config.slackChannel &&
          config.slackTeam &&
          config.slackUsers.length
            ? 'environment'
            : 'missing',
      },
      {
        id: 'computers',
        section: 'computers' as const,
        label: 'Computer Services',
        required: false,
        configured: !!(
          config.computerSupervisorUrl &&
          config.computerSupervisorToken &&
          config.computerToken
        ),
        valid: !!(
          config.computerSupervisorUrl &&
          config.computerSupervisorToken &&
          config.computerToken
        ),
        source:
          config.computerSupervisorUrl &&
          config.computerSupervisorToken &&
          config.computerToken
            ? 'environment'
            : 'missing',
      },
    );

    return requirements;
  }

  /**
   * Determine if setup is complete based on requirements.
   */
  private isSetupComplete(config: PlatformConfig): boolean {
    const requirements = this.getRequirements(config);
    return requirements.filter((r) => r.required).every((r) => r.configured);
  }

  /**
   * Get the current managed configuration from FeltDB.
   */
  private async getManagedConfiguration(): Promise<ManagedConfiguration | null> {
    const collections = storeCollections(this.db);
    const records = await collections.configurations.all();

    const owned = records.find((r) => r.ownerId === this.ownerId);
    if (!owned) return null;
    return toConfiguration(owned);
  }

  /**
   * Save managed configuration to FeltDB.
   * Only non-secret fields are persisted.
   */
  async saveConfiguration(partial: Partial<ManagedConfiguration>): Promise<ManagedConfiguration> {
    const collections = storeCollections(this.db);
    const now = Date.now();

    // Get existing or create new
    let existing = await this.getManagedConfiguration();

    const configuration: ManagedConfiguration = {
      id: existing?.id || `config-${Date.now()}`,
      ownerId: this.ownerId,
      intelligence: {
        apiUrl: partial.intelligence?.apiUrl ?? existing?.intelligence?.apiUrl,
        wsUrl: partial.intelligence?.wsUrl ?? existing?.intelligence?.wsUrl,
        model: partial.intelligence?.model ?? existing?.intelligence?.model,
        baseUrl: partial.intelligence?.baseUrl ?? existing?.intelligence?.baseUrl,
      },
      browser: {
        url: partial.browser?.url ?? existing?.browser?.url,
        host: partial.browser?.host ?? existing?.browser?.host,
        port: partial.browser?.port ?? existing?.browser?.port,
      },
      voice: {
        model: partial.voice?.model ?? existing?.voice?.model,
        name: partial.voice?.name ?? existing?.voice?.name,
      },
      slack: {
        channelName: partial.slack?.channelName ?? existing?.slack?.channelName,
        teamId: partial.slack?.teamId ?? existing?.slack?.teamId,
        userIds: partial.slack?.userIds ?? existing?.slack?.userIds,
        dotId: partial.slack?.dotId ?? existing?.slack?.dotId,
      },
      computers: {
        namespace: partial.computers?.namespace ?? existing?.computers?.namespace,
        memoryBytes: partial.computers?.memoryBytes ?? existing?.computers?.memoryBytes,
        runtime: partial.computers?.runtime ?? existing?.computers?.runtime,
        engineSocket: partial.computers?.engineSocket ?? existing?.computers?.engineSocket,
      },
      appOrigin: partial.appOrigin ?? existing?.appOrigin,
      savedAt: existing?.savedAt || now,
      updatedAt: now,
    };

    // Remove empty sections
    if (!configuration.intelligence?.apiUrl &&
        !configuration.intelligence?.wsUrl &&
        !configuration.intelligence?.model &&
        !configuration.intelligence?.baseUrl) {
      delete configuration.intelligence;
    }
    if (!configuration.browser?.url &&
        !configuration.browser?.host &&
        !configuration.browser?.port) {
      delete configuration.browser;
    }
    if (!configuration.voice?.model && !configuration.voice?.name) {
      delete configuration.voice;
    }
    if (!configuration.slack?.channelName &&
        !configuration.slack?.teamId &&
        !configuration.slack?.userIds?.length &&
        !configuration.slack?.dotId) {
      delete configuration.slack;
    }
    if (!configuration.computers?.namespace &&
        !configuration.computers?.memoryBytes &&
        !configuration.computers?.runtime &&
        !configuration.computers?.engineSocket) {
      delete configuration.computers;
    }

    // Use transaction to save configuration
    const record = (configuration as unknown) as typeof configuration & { __version?: number };
    record.__version = 1;

    await this.db.transaction((tx) => {
      tx.collection<ConfigurationRecord>('configurations').set(
        configuration.id,
        record,
      );
    });

    return configuration;
  }
}
