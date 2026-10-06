import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';

/**
 * Intelligence: OpenDots' model-inference capability.
 *
 * Three concerns are kept apart on purpose:
 *
 * - **Provider catalogue** — which providers OpenDots can actually call. Every
 *   provider is reached through the same OpenAI-compatible chat-completions
 *   interface; there is no second model abstraction.
 * - **Credentials** — resolved through a {@link CredentialResolver} at request
 *   time. The only implementation today reads the process environment, because
 *   no secret custody exists yet that OpenDots can delegate to (AppPort defines
 *   `ScopedSecretsResolver` as a protocol only and ships no provider). Provider
 *   keys are never written to FeltDB.
 * - **Settings** — provider, model and base URL are durable Setup configuration,
 *   read fresh for every request so a change in Setup applies to the next turn.
 *
 * Intelligence does not own conversation state; that is FeltDB's.
 */

export type IntelligenceProviderId = 'openai' | 'anthropic';

export interface IntelligenceProvider {
  id: IntelligenceProviderId;
  label: string;
  /** The environment variable that holds this provider's credential. */
  credentialVariable: string;
  /** The provider's OpenAI-compatible chat-completions base URL. */
  defaultBaseUrl: string;
}

export const INTELLIGENCE_PROVIDERS: Record<
  IntelligenceProviderId,
  IntelligenceProvider
> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    credentialVariable: 'OPENAI_API_KEY',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    credentialVariable: 'ANTHROPIC_API_KEY',
    // Anthropic's OpenAI SDK compatibility endpoint.
    defaultBaseUrl: 'https://api.anthropic.com/v1/',
  },
};

export function isProviderId(value: unknown): value is IntelligenceProviderId {
  return (
    typeof value === 'string' && Object.hasOwn(INTELLIGENCE_PROVIDERS, value)
  );
}

/**
 * Server-only credential access, shaped after AppPort's `ScopedSecretsResolver`:
 * material is handed to a callback and never returned to a caller that could
 * persist or serialise it.
 */
export interface CredentialResolver {
  has(provider: IntelligenceProviderId): boolean;
  withCredential<T>(
    provider: IntelligenceProviderId,
    use: (credential: string) => T,
  ): T;
}

/** Credentials held by the process environment, read at call time. */
export class EnvironmentCredentials implements CredentialResolver {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}
  private value(provider: IntelligenceProviderId) {
    return this.env[
      INTELLIGENCE_PROVIDERS[provider].credentialVariable
    ]?.trim();
  }
  has(provider: IntelligenceProviderId) {
    return !!this.value(provider);
  }
  withCredential<T>(
    provider: IntelligenceProviderId,
    use: (credential: string) => T,
  ) {
    const credential = this.value(provider);
    if (!credential)
      throw new Error(
        `${INTELLIGENCE_PROVIDERS[provider].label} credential is not configured: set ${INTELLIGENCE_PROVIDERS[provider].credentialVariable}.`,
      );
    return use(credential);
  }
}

/** Non-secret Intelligence settings. */
export interface IntelligenceSettings {
  provider?: IntelligenceProviderId;
  model?: string;
  baseUrl?: string;
}

/**
 * Environment bootstrap defaults, used only for fields Setup has not saved.
 *
 * `appliesTo` is the provider the bootstrap model and base URL were written
 * for. They are never applied to a different provider: an `OPENAI_BASE_URL`
 * must not redirect an Anthropic request (and its key) to OpenAI.
 */
export interface BootstrapSettings extends IntelligenceSettings {
  appliesTo?: IntelligenceProviderId;
}

export function bootstrapSettings(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapSettings {
  const explicit = env.INTELLIGENCE_PROVIDER?.trim();
  if (isProviderId(explicit))
    return {
      provider: explicit,
      appliesTo: explicit,
      model: env.INTELLIGENCE_MODEL?.trim() || undefined,
      baseUrl: env.INTELLIGENCE_BASE_URL?.trim() || undefined,
    };
  const model = env.OPENAI_MODEL?.trim() || undefined;
  return {
    provider: env.OPENAI_API_KEY?.trim() && model ? 'openai' : undefined,
    appliesTo: 'openai',
    model,
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
  };
}

/** Saved Setup values first; bootstrap values only for the provider they name. */
export function resolveSettings(
  saved: IntelligenceSettings | undefined,
  bootstrap: BootstrapSettings,
): IntelligenceSettings {
  const provider = saved?.provider ?? bootstrap.provider;
  const sameProvider = !!provider && provider === bootstrap.appliesTo;
  return {
    provider,
    model: saved?.model ?? (sameProvider ? bootstrap.model : undefined),
    baseUrl: saved?.baseUrl ?? (sameProvider ? bootstrap.baseUrl : undefined),
  };
}

export interface IntelligenceStatus {
  ready: boolean;
  provider?: IntelligenceProviderId;
  model?: string;
  credentialConfigured: boolean;
  /** Human-readable names of what is still missing. */
  missing: string[];
}

export function intelligenceStatus(
  settings: IntelligenceSettings,
  credentials: CredentialResolver,
): IntelligenceStatus {
  const { provider, model } = settings;
  const credentialConfigured = !!provider && credentials.has(provider);
  const missing = [
    !provider && 'Intelligence provider',
    !model && 'Intelligence model',
    provider &&
      !credentialConfigured &&
      INTELLIGENCE_PROVIDERS[provider].credentialVariable,
  ].filter((item): item is string => !!item);
  return {
    ready: !missing.length,
    provider,
    model,
    credentialConfigured,
    missing,
  };
}

export type ModelAdapter = ReturnType<typeof openaiCompatibleText>;

export interface ResolvedModel {
  provider: IntelligenceProviderId;
  model: string;
  adapter: ModelAdapter;
}

export type AdapterFactory = (
  model: string,
  options: { apiKey: string; baseURL: string },
) => ModelAdapter;

const defaultAdapterFactory: AdapterFactory = (model, { apiKey, baseURL }) =>
  openaiCompatibleText(model, {
    apiKey,
    baseURL,
    api: 'chat-completions',
    maxRetries: 1,
  });

/** Where saved Setup settings come from. */
export interface IntelligenceSettingsSource {
  savedIntelligenceSettings(): Promise<IntelligenceSettings | undefined>;
}

export class IntelligenceService {
  constructor(
    private source: IntelligenceSettingsSource,
    readonly credentials: CredentialResolver = new EnvironmentCredentials(),
    private bootstrap: BootstrapSettings = bootstrapSettings(),
    private adapterFactory: AdapterFactory = defaultAdapterFactory,
  ) {}

  async settings(): Promise<IntelligenceSettings> {
    return resolveSettings(
      await this.source.savedIntelligenceSettings(),
      this.bootstrap,
    );
  }

  async status(): Promise<IntelligenceStatus> {
    return intelligenceStatus(await this.settings(), this.credentials);
  }

  /**
   * Resolve the model for one request from the current durable configuration.
   * The credential goes straight from the resolver into the provider client.
   */
  async resolveModel(): Promise<ResolvedModel> {
    const settings = await this.settings();
    const status = intelligenceStatus(settings, this.credentials);
    if (!status.ready)
      throw new Error(
        `Intelligence setup required: ${status.missing.join(', ')}.`,
      );
    const provider = settings.provider!;
    const model = settings.model!;
    const baseURL =
      settings.baseUrl ?? INTELLIGENCE_PROVIDERS[provider].defaultBaseUrl;
    const adapter = this.credentials.withCredential(provider, (apiKey) =>
      this.adapterFactory(model, { apiKey, baseURL }),
    );
    return { provider, model, adapter };
  }
}
