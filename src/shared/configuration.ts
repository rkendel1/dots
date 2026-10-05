/**
 * The configuration domain model shared by the server and the Setup UI.
 *
 * Two ideas are kept apart on purpose, because conflating them is what makes a
 * settings screen unsafe:
 *
 *   1. **Settings** are product concepts a person configures — "Model", "Browser
 *      service address". They have no environment-variable names in this file.
 *   2. **Secrets** are credentials. OpenDots can report whether one is present
 *      and never what it is. The server never returns a secret value, so nothing
 *      here has a field that could hold one — the type system is the guarantee,
 *      not a runtime filter that a later change could forget to apply.
 *
 * The mapping from a setting to the environment variable that can also supply it
 * lives on the server (`server/configuration-registry.ts`), beside the runtime
 * that reads it. The browser only ever sees the shapes below.
 */

/** The areas OpenDots is configured in, in the order a person meets them. */
export type ConfigurationSectionId =
  | 'core'
  | 'intelligence'
  | 'browser'
  | 'voice'
  | 'slack'
  | 'computers'
  | 'compute';

/**
 * Where a setting's effective value came from.
 *
 * `environment` is authoritative and read-only: an operator who exported a
 * variable meant it, and a settings screen that quietly overrode it would make
 * deployment configuration untrustworthy. `managed` is what the UI writes.
 */
export type ConfigurationSource = 'environment' | 'managed' | 'default' | 'missing';

/**
 * Where a secret's material comes from.
 *
 * Today only `environment` exists. `secret-reference` is reserved for the
 * AppBoundry `ScopedSecretsResolver` integration, so the read model and the UI
 * can grow that case without a breaking change: it becomes another source, not a
 * new shape.
 */
export type SecretSource = 'environment' | 'secret-reference' | 'missing';

/**
 * One non-secret setting, as reported to the browser.
 *
 * `value` is present only here, and only for non-secret settings. A secret's
 * counterpart, {@link SecretSettingStatus}, has no `value` field to leak.
 */
export interface SettingStatus {
  configured: boolean;
  /** Whether the effective value satisfies this setting's own rule. */
  valid: boolean;
  source: ConfigurationSource;
  /** The effective value, when this setting has one to show. */
  value?: string;
  /** Why the current value is not acceptable, in one sentence. */
  problem?: string;
  /** Whether OpenDots will accept a change here at all. */
  editable: boolean;
  /** Why it is not editable, in one sentence. */
  note?: string;
}

/**
 * One secret, as reported to the browser: presence only.
 *
 * There is deliberately no `value`, no `hint` and no length. A masked preview
 * still leaks, and "configured: true" is all a person needs to know.
 */
export interface SecretSettingStatus {
  configured: boolean;
  source: SecretSource;
  /** Always false in this PR: OpenDots cannot yet accept secret material. */
  editable: false;
  /** Why the value cannot be changed here. */
  note: string;
}

/** One thing OpenDots needs, and whether it currently has it. */
export interface RequirementStatus {
  id: string;
  section: ConfigurationSectionId;
  /** Product language, never an environment variable name. */
  label: string;
  required: boolean;
  configured: boolean;
  valid: boolean;
  source: ConfigurationSource;
}

export interface ConfigurationSectionStatus {
  id: ConfigurationSectionId;
  label: string;
  /** Whether any requirement in this section must be met before OpenDots runs. */
  required: boolean;
  settings: Record<string, SettingStatus>;
  secrets: Record<string, SecretSettingStatus>;
}

/**
 * The whole safe read model: `GET /api/setup` and `GET /api/configuration`.
 *
 * `setupComplete` is derived, never stored — see `server/configuration.ts`. It is
 * true when every *required* requirement is configured and valid, which is why an
 * uninstalled optional integration can never block the application.
 */
export interface SetupState {
  setupComplete: boolean;
  sections: ConfigurationSectionStatus[];
  requirements: RequirementStatus[];
}