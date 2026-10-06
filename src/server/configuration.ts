import type { StateFirstDB } from '@feltdb/core';
import type {
  ConfigurationReadModel,
  ConfigurationRequirement,
  ManagedConfiguration,
  SecretStatus,
} from '../shared/types.js';
import {
  storeCollections,
  toConfiguration,
  type ConfigurationRecord,
} from './store-collections.js';
import type { PlatformConfig } from './platform-config.js';
import { ComputeReadinessStore } from './compute-readiness-store.js';
import {
  bootstrapSettings,
  EnvironmentCredentials,
  INTELLIGENCE_PROVIDERS,
  intelligenceStatus,
  isProviderId,
  resolveSettings,
  type CredentialResolver,
  type BootstrapSettings,
  type IntelligenceSettings,
  type IntelligenceSettingsSource,
} from './intelligence.js';

/**
 * Durable, non-secret application configuration.
 *
 * Setup writes it; the runtime reads it on every request. For Intelligence a
 * saved Setup value takes precedence over the environment, which is only a
 * bootstrap default for fields Setup has not saved. Provider credentials are
 * never stored here — they are resolved through a {@link CredentialResolver}.
 */
export class ConfigurationService implements IntelligenceSettingsSource {
  private computeReadiness: ComputeReadinessStore;

  constructor(
    private db: StateFirstDB,
    private ownerId: string,
    readonly credentials: CredentialResolver = new EnvironmentCredentials(),
    private bootstrap: BootstrapSettings = bootstrapSettings(),
  ) {
    this.computeReadiness = new ComputeReadinessStore(db);
  }

  private secretStatus(value: string | undefined): SecretStatus {
    return { configured: !!value, source: value ? 'environment' : undefined };
  }

  async savedIntelligenceSettings(): Promise<IntelligenceSettings | undefined> {
    const saved = (await this.getManagedConfiguration())?.intelligence;
    if (!saved) return undefined;
    return {
      provider: isProviderId(saved.provider) ? saved.provider : undefined,
      model: saved.model || undefined,
      baseUrl: saved.baseUrl || undefined,
    };
  }

  async getConfiguration(
    config: PlatformConfig,
  ): Promise<ConfigurationReadModel> {
    const managed = await this.getManagedConfiguration();
    const computeState = await this.computeReadiness.current();
    const intelligence = intelligenceStatus(
      resolveSettings(await this.savedIntelligenceSettings(), this.bootstrap),
      this.credentials,
    );
    const requirements = this.getRequirements(config, intelligence);

    return {
      setupComplete: requirements
        .filter((r) => r.required)
        .every((r) => r.configured),
      sections: {
        core: {
          ownerId: config.ownerToken ? 'configured' : undefined,
          appOrigin: managed?.appOrigin,
          ownerToken: this.secretStatus(config.ownerToken),
        },
        intelligence: {
          configured: intelligence.ready,
          provider: intelligence.provider,
          model: intelligence.model,
          baseUrl: managed?.intelligence?.baseUrl,
          apiKey: {
            configured: intelligence.credentialConfigured,
            source: intelligence.credentialConfigured
              ? 'environment'
              : undefined,
          },
          credentialVariable: intelligence.provider
            ? INTELLIGENCE_PROVIDERS[intelligence.provider].credentialVariable
            : undefined,
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
      requirements,
    };
  }

  private getRequirements(
    config: PlatformConfig,
    intelligence: ReturnType<typeof intelligenceStatus>,
  ): ConfigurationRequirement[] {
    const credentialRequirement: ConfigurationRequirement[] =
      intelligence.provider
        ? [
            {
              id: 'intelligence_credential',
              section: 'intelligence',
              label: `${INTELLIGENCE_PROVIDERS[intelligence.provider].label} credential`,
              required: true,
              configured: intelligence.credentialConfigured,
              valid: intelligence.credentialConfigured,
              source: intelligence.credentialConfigured
                ? 'environment'
                : 'missing',
            },
          ]
        : [];
    return [
      {
        id: 'intelligence',
        section: 'intelligence',
        label: 'Intelligence Provider',
        required: true,
        configured: !!intelligence.provider && !!intelligence.model,
        valid: !!intelligence.provider && !!intelligence.model,
        source:
          intelligence.provider && intelligence.model ? 'managed' : 'missing',
      },
      ...credentialRequirement,
      {
        id: 'browser',
        section: 'browser',
        label: 'Browser Service',
        required: false,
        configured: !!(config.browserUrl && config.browserSecret),
        valid: !!(config.browserUrl && config.browserSecret),
        source:
          config.browserUrl && config.browserSecret ? 'environment' : 'missing',
      },
      {
        id: 'voice',
        section: 'voice',
        label: 'Voice Service',
        required: false,
        configured: !!(config.voiceKey && config.voiceModel),
        valid: !!(config.voiceKey && config.voiceModel),
        source:
          config.voiceKey && config.voiceModel ? 'environment' : 'missing',
      },
      {
        id: 'computers',
        section: 'computers',
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
    ];
  }

  private async getManagedConfiguration(): Promise<ManagedConfiguration | null> {
    const records = await storeCollections(this.db).configurations.all();
    const owned = records.find((r) => r.ownerId === this.ownerId);
    return owned ? toConfiguration(owned) : null;
  }

  /**
   * Remove any provider credential an earlier build wrote into durable
   * configuration. The value is dropped, never read out, logged or copied.
   * Returns how many records were rewritten.
   */
  async scrubPlaintextCredentials(): Promise<number> {
    const records = await storeCollections(this.db).configurations.all();
    let scrubbed = 0;
    for (const record of records) {
      const intelligence = record.intelligence as
        (Record<string, unknown> & { apiKey?: unknown }) | undefined;
      if (!intelligence || !('apiKey' in intelligence)) continue;
      const { apiKey: _dropped, ...rest } = intelligence;
      void _dropped;
      const next = {
        ...toConfiguration(record),
        intelligence: rest,
        updatedAt: Date.now(),
      };
      await this.write(next);
      scrubbed++;
    }
    return scrubbed;
  }

  async saveConfiguration(
    partial: Partial<ManagedConfiguration>,
  ): Promise<ManagedConfiguration> {
    const existing = await this.getManagedConfiguration();
    const now = Date.now();
    const configuration: ManagedConfiguration = {
      id: existing?.id || `config-${now}`,
      ownerId: this.ownerId,
      intelligence: {
        provider:
          partial.intelligence?.provider ?? existing?.intelligence?.provider,
        model: partial.intelligence?.model ?? existing?.intelligence?.model,
        baseUrl:
          partial.intelligence?.baseUrl ?? existing?.intelligence?.baseUrl,
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
      computers: {
        namespace:
          partial.computers?.namespace ?? existing?.computers?.namespace,
        memoryBytes:
          partial.computers?.memoryBytes ?? existing?.computers?.memoryBytes,
        runtime: partial.computers?.runtime ?? existing?.computers?.runtime,
        engineSocket:
          partial.computers?.engineSocket ?? existing?.computers?.engineSocket,
      },
      appOrigin: partial.appOrigin ?? existing?.appOrigin,
      savedAt: existing?.savedAt || now,
      updatedAt: now,
    };
    const isEmpty = (section?: object) =>
      !section || Object.values(section).every((value) => value === undefined);
    if (isEmpty(configuration.intelligence)) delete configuration.intelligence;
    if (isEmpty(configuration.browser)) delete configuration.browser;
    if (isEmpty(configuration.voice)) delete configuration.voice;
    if (isEmpty(configuration.computers)) delete configuration.computers;
    await this.write(configuration);
    return configuration;
  }

  private async write(configuration: ManagedConfiguration) {
    // FeltDB rejects `undefined` field values; drop them before staging.
    const record = JSON.parse(
      JSON.stringify(configuration),
    ) as ConfigurationRecord;
    record.__version = 1;
    await this.db.transaction((tx) => {
      tx.collection<ConfigurationRecord>('configurations').set(
        configuration.id,
        record,
      );
    });
  }
}
