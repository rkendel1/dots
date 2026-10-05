/**
 * What OpenDots is configured with, and how each setting is judged.
 *
 * This is the only file that knows an environment variable name. The UI knows
 * product labels; the runtime knows which value it reads. Both are derived from
 * the list below, so a setting cannot exist in one place and be missing from the
 * other.
 *
 * ## Precedence
 *
 * `environment` beats `managed`. An exported variable is deployment intent, and
 * silently overriding it from a browser would make an operator's environment
 * untrustworthy. Managed configuration fills in what the environment leaves
 * unset, which lets a developer stop maintaining `.env` while an existing
 * deployment keeps behaving exactly as it does today.
 */
import type {
  ConfigurationSectionId,
  ConfigurationSource,
} from '../shared/configuration.js';

/** How a setting's text is validated, and how the UI presents it. */
export type SettingKind = 'text' | 'url' | 'websocketUrl' | 'list';

export interface SettingDefinition {
  /** Stable id, also the key in the read model and in managed storage. */
  id: string;
  section: ConfigurationSectionId;
  /** Product language. Never an environment variable name. */
  label: string;
  /** The variable that can supply this setting, when the environment is set. */
  env: string;
  kind: SettingKind;
  /** Used when neither the environment nor managed configuration supplies one. */
  defaultValue?: string;
  /**
   * Whether the UI may write this setting.
   *
   * False for anything the process consumes before it can serve a request, or
   * anything the managed layer does not feed back into the runtime.
   */
  editable: boolean;
  /** Why it is not editable. Shown to the person. */
  note?: string;
}

export interface SecretDefinition {
  id: string;
  section: ConfigurationSectionId;
  label: string;
  /** The variable that supplies it. OpenDots reads presence, never the value. */
  env: string;
  /** Whether OpenDots cannot start work without it. */
  required: boolean;
}

export const SETTINGS: readonly SettingDefinition[] = [
  /* ── Core ───────────────────────────────────────────────────────────────
   * `OWNER_ID` names the durable conversation owner and `APP_ORIGIN` decides
   * which origins the API accepts. Both are read while the process is starting,
   * before it can answer a request, and both are identities rather than
   * tunables: changing the owner would orphan existing conversations, and
   * changing the origin after the guard is built would leave a window where the
   * running guard disagrees with the configured value. They are shown, and
   * read-only, so Setup can still explain what the deployment decided.
   */
  {
    id: 'core.ownerId',
    section: 'core',
    label: 'Owner',
    env: 'OWNER_ID',
    kind: 'text',
    defaultValue: 'opendots-owner',
    editable: false,
    note: 'Read when OpenDots starts. Changing it would orphan existing conversations.',
  },
  {
    id: 'core.appOrigin',
    section: 'core',
    label: 'Application origin',
    env: 'APP_ORIGIN',
    kind: 'url',
    editable: false,
    note: 'Read when OpenDots starts, and enforced on every API request.',
  },

  /* ── Intelligence ────────────────────────────────────────────────────────
   * The provider itself is a single existing runtime (`research.ts` talks to an
   * OpenAI-compatible chat-completions endpoint). Its base URL and model are
   * therefore plain settings rather than a second provider registry.
   */
  {
    id: 'intelligence.apiUrl',
    section: 'intelligence',
    label: 'Intelligence API URL',
    env: 'INTELLIGENCE_API_URL',
    kind: 'url',
    editable: true,
  },
  {
    id: 'intelligence.wsUrl',
    section: 'intelligence',
    label: 'Intelligence WebSocket URL',
    env: 'INTELLIGENCE_WS_URL',
    kind: 'websocketUrl',
    editable: true,
  },
  {
    id: 'intelligence.providerBaseUrl',
    section: 'intelligence',
    label: 'Model provider URL',
    env: 'OPENAI_BASE_URL',
    kind: 'url',
    defaultValue: 'https://api.openai.com/v1',
    editable: true,
  },
  /* ── Browser ───────────────────────────────────────────────────────────
   * `BROWSER_HOST` and `BROWSER_PORT` are deliberately absent: they configure
   * the separate browser service process (`browser/index.ts`), which has its own
   * environment. A setting here could not change that process, and offering one
   * would be a lie.
   */
  {
    id: 'browser.url',
    section: 'browser',
    label: 'Browser service URL',
    env: 'BROWSER_URL',
    kind: 'url',
    editable: true,
  },

  /* ── Voice ──────────────────────────────────────────────────────────────── */
  {
    id: 'voice.model',
    section: 'voice',
    label: 'Voice model',
    env: 'VOICE_MODEL',
    kind: 'text',
    editable: true,
  },
  {
    id: 'voice.name',
    section: 'voice',
    label: 'Voice name',
    env: 'VOICE_NAME',
    kind: 'text',
    defaultValue: 'marin',
    editable: true,
  },

  /* ── Slack ──────────────────────────────────────────────────────────────── */
  {
    id: 'slack.channel',
    section: 'slack',
    label: 'Channel',
    env: 'SLACK_CHANNEL_NAME',
    kind: 'text',
    editable: true,
  },
  {
    id: 'slack.workspace',
    section: 'slack',
    label: 'Workspace',
    env: 'SLACK_TEAM_ID',
    kind: 'text',
    editable: true,
  },
  {
    id: 'slack.userIds',
    section: 'slack',
    label: 'Allowed users',
    env: 'SLACK_USER_IDS',
    kind: 'list',
    editable: true,
  },
  {
    id: 'slack.dot',
    section: 'slack',
    label: 'Dot',
    env: 'SLACK_DOT_ID',
    kind: 'text',
    editable: true,
  },

  /* ── Computers ─────────────────────────────────────────────────────────
   * `COMPUTER_MEMORY_BYTES`, `COMPUTER_RUNTIME` and `ENGINE_SOCKET` appear in
   * the old `.env.example` but are read nowhere in the server. They are
   * therefore not settings: offering a field no runtime consumes would let
   * someone believe a value had been applied when nothing read it.
   */
  {
    id: 'computers.supervisorUrl',
    section: 'computers',
    label: 'Supervisor URL',
    env: 'COMPUTER_SUPERVISOR_URL',
    kind: 'url',
    editable: true,
  },

  /* ── Compute ────────────────────────────────────────────────────────────
   * Compute endpoint for portable workload execution and agent runtime access.
   * Non-secret configuration; credentials remain in the secret boundary.
   */
  {
    id: 'compute.endpoint',
    section: 'compute',
    label: 'Compute endpoint',
    env: 'COMPUTE_ENDPOINT',
    kind: 'url',
    editable: true,
  },
];

/**
 * The credentials OpenDots needs but must never accept, store, or return.
 *
 * Presence is reported; material is not. `required` mirrors the existing gate in
 * `platform-config.ts`, so Setup cannot claim a readiness the runtime lacks.
 */
export const SECRETS: readonly SecretDefinition[] = [
  {
    id: 'owner.token',
    section: 'core',
    label: 'Owner access token',
    env: 'OWNER_TOKEN',
    required: false,
  },
  {
    id: 'intelligence.apiKey',
    section: 'intelligence',
    label: 'Intelligence API key',
    env: 'INTELLIGENCE_API_KEY',
    required: true,
  },
  {
    id: 'intelligence.modelApiKey',
    section: 'intelligence',
    label: 'Model provider API key',
    env: 'OPENAI_API_KEY',
    required: true,
  },
  {
    id: 'browser.secret',
    section: 'browser',
    label: 'Browser secret',
    env: 'BROWSER_SECRET',
    required: false,
  },
  {
    id: 'voice.apiKey',
    section: 'voice',
    label: 'Voice API key',
    env: 'VOICE_API_KEY',
    required: false,
  },
  {
    id: 'computers.supervisorToken',
    section: 'computers',
    label: 'Supervisor token',
    env: 'COMPUTER_SUPERVISOR_TOKEN',
    required: false,
  },
  {
    id: 'computers.computerToken',
    section: 'computers',
    label: 'Computer token',
    env: 'COMPUTER_TOKEN',
    required: false,
  },
];

export const SECTION_LABELS: Record<ConfigurationSectionId, string> = {
  core: 'Core',
  intelligence: 'Intelligence',
  browser: 'Browser',
  voice: 'Voice',
  slack: 'Slack',
  computers: 'Computers',
  compute: 'Compute',
};

/**
 * Why a secret cannot be changed from OpenDots yet.
 *
 * Named once so the UI, the API and the tests cannot drift into telling a
 * different story.
 */
export const SECRET_NOTE =
  'Provided by the deployment environment. OpenDots cannot accept, store, or display secret material.';

const MAX_LENGTH = 2000;

/** Why a value is not usable, or `undefined` when it is. */
export function validate(
  value: string | undefined,
  kind: SettingKind,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_LENGTH)
    return `Must be ${MAX_LENGTH} characters or fewer.`;
  if (kind === 'text') return undefined;
  if (kind === 'list') {
    const entries = trimmed.split(',').map((part) => part.trim());
    if (entries.some((entry) => !entry))
      return 'Remove the empty entries between commas.';
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a complete URL, including https://.';
  }
  const allowed = kind === 'websocketUrl' ? ['ws:', 'wss:'] : ['http:', 'https:'];
  if (!allowed.includes(url.protocol))
    return kind === 'websocketUrl'
      ? 'A WebSocket URL must start with ws:// or wss://.'
      : 'A URL must start with http:// or https://.';
  return undefined;
}

/** How a setting's effective value is assembled, given what each source offers. */
export function effective(
  environment: string | undefined,
  managed: string | undefined,
  definition: SettingDefinition,
): { value: string | undefined; source: ConfigurationSource } {
  const fromEnvironment = environment?.trim();
  if (fromEnvironment) return { value: fromEnvironment, source: 'environment' };
  const fromManaged = managed?.trim();
  if (fromManaged) return { value: fromManaged, source: 'managed' };
  if (definition.defaultValue)
    return { value: definition.defaultValue, source: 'default' };
  return { value: undefined, source: 'missing' };
}