import { useEffect, useState } from 'react';
import { api } from './api';
import { AlertCircle, Check, Circle, Save } from 'lucide-react';
import type {
  ConfigurationReadModel,
  ManagedConfiguration,
} from '../shared/types';
import './setup-dialog.css';

interface SetupDialogProps {
  onComplete?: () => void;
  isOpen: boolean;
}

type Section = 'intelligence' | 'browser' | 'voice' | 'computers';
type Provider = 'anthropic' | 'openai';

const PROVIDERS: Record<
  Provider,
  {
    label: string;
    credentialVariable: string;
    modelPlaceholder: string;
    baseUrl: string;
  }
> = {
  anthropic: {
    label: 'Anthropic (Claude)',
    credentialVariable: 'ANTHROPIC_API_KEY',
    modelPlaceholder: 'claude-haiku-4-5',
    baseUrl: 'https://api.anthropic.com/v1/',
  },
  openai: {
    label: 'OpenAI',
    credentialVariable: 'OPENAI_API_KEY',
    modelPlaceholder: 'gpt-4.1-mini',
    baseUrl: 'https://api.openai.com/v1',
  },
};

export function SetupDialog({ onComplete, isOpen }: SetupDialogProps) {
  const [config, setConfig] = useState<ConfigurationReadModel | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeSection, setActiveSection] = useState<Section>('intelligence');
  const [formData, setFormData] = useState<Partial<ManagedConfiguration>>({});

  const load = async () => {
    const data = await api<ConfigurationReadModel>('/configuration');
    setConfig(data);
    setFormData({
      intelligence: {
        provider: data.sections.intelligence.provider ?? 'anthropic',
        model: data.sections.intelligence.model,
        baseUrl: data.sections.intelligence.baseUrl,
      },
      browser: data.sections.browser,
      voice: data.sections.voice,
      computers: data.sections.computers,
      appOrigin: data.sections.core.appOrigin,
    });
  };

  useEffect(() => {
    if (!isOpen) return;
    setSaved(false);
    load().catch((e) =>
      setError(e instanceof Error ? e.message : 'Failed to load configuration'),
    );
  }, [isOpen]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await api('/configuration', 'PUT', managedPayload(formData));
      const updated = await api<ConfigurationReadModel>('/configuration');
      setConfig(updated);
      setSaved(true);
      if (updated.setupComplete) onComplete?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen || !config) return null;

  const requiredMissing = config.requirements.filter(
    (r) => r.required && !r.configured,
  );
  const canSave = !!(
    formData.intelligence?.provider && formData.intelligence?.model?.trim()
  );

  return (
    <div className="setup-overlay">
      <div className="setup-dialog">
        <div className="setup-header">
          <h1>OpenDots Setup</h1>
          <p>Configure your application to get started</p>
        </div>

        {error && (
          <div className="setup-error">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        )}

        <div className="setup-content">
          <div className="requirements-summary">
            <h2>Setup Status</h2>
            {config.requirements.map((req) => (
              <div key={req.id} className="requirement-item">
                <div className="requirement-status">
                  {req.configured ? (
                    <Check className="icon-check" size={16} />
                  ) : (
                    <Circle
                      className={
                        req.required ? 'icon-missing' : 'icon-optional'
                      }
                      size={16}
                    />
                  )}
                </div>
                <div className="requirement-label">
                  <span>{req.label}</span>
                  {req.required && !req.configured && (
                    <span className="required-badge">Required</span>
                  )}
                  {!req.required && (
                    <span className="optional-badge">Optional</span>
                  )}
                </div>
                <div className="requirement-source">
                  {req.configured ? (
                    <span className="source-env">Ready</span>
                  ) : (
                    <span className="source-missing">Not configured</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="configuration-sections">
            <div className="section-tabs">
              {(['intelligence', 'browser', 'voice', 'computers'] as const).map(
                (section) => (
                  <button
                    key={section}
                    className={`section-tab ${activeSection === section ? 'active' : ''}`}
                    onClick={() => setActiveSection(section)}
                  >
                    {section.charAt(0).toUpperCase() + section.slice(1)}
                  </button>
                ),
              )}
            </div>

            <div className="section-content">
              {activeSection === 'intelligence' && (
                <IntelligenceSection
                  config={config.sections.intelligence}
                  formData={formData.intelligence}
                  onChange={(data) =>
                    setFormData({ ...formData, intelligence: data })
                  }
                />
              )}
              {activeSection === 'browser' && (
                <BrowserSection
                  config={config.sections.browser}
                  formData={formData.browser}
                  onChange={(data) =>
                    setFormData({ ...formData, browser: data })
                  }
                />
              )}
              {activeSection === 'voice' && (
                <VoiceSection
                  config={config.sections.voice}
                  formData={formData.voice}
                  onChange={(data) => setFormData({ ...formData, voice: data })}
                />
              )}
              {activeSection === 'computers' && (
                <ComputersSection
                  config={config.sections.computers}
                  formData={formData.computers}
                  onChange={(data) =>
                    setFormData({ ...formData, computers: data })
                  }
                />
              )}
            </div>
          </div>

          <div className="core-settings">
            <h3>Application Origin (Optional)</h3>
            <input
              type="url"
              placeholder="http://localhost:5173"
              value={formData.appOrigin || ''}
              onChange={(e) =>
                setFormData({ ...formData, appOrigin: e.target.value })
              }
              className="setup-input"
            />
          </div>
        </div>

        <div className="setup-footer">
          {saved && !requiredMissing.length ? (
            <div className="setup-complete">
              <Check size={16} />
              <span>Saved. Setup is complete.</span>
            </div>
          ) : (
            requiredMissing.length > 0 && (
              <div className="missing-count">
                {saved ? 'Saved. Still needed: ' : 'Still needed: '}
                {requiredMissing.map((r) => r.label).join(', ')}
              </div>
            )
          )}
          <button
            className="setup-button"
            onClick={handleSave}
            disabled={saving || !canSave}
          >
            {saving ? 'Saving...' : 'Save Configuration'}
            {!saving && <Save size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}

// Send only managed fields and drop blanks: the server rejects "" for URLs and
// names, and the read model carries status objects that are not settings.
function managedPayload(form: Partial<ManagedConfiguration>) {
  const pick = <T extends object>(source: T | undefined, keys: (keyof T)[]) => {
    const out: Partial<T> = {};
    for (const key of keys) {
      const value = source?.[key];
      if (value === undefined || value === null) continue;
      if (typeof value === 'string' && !value.trim()) continue;
      out[key] = (
        typeof value === 'string' ? value.trim() : value
      ) as T[keyof T];
    }
    return Object.keys(out).length ? out : undefined;
  };
  type M = ManagedConfiguration;
  return {
    intelligence: pick<NonNullable<M['intelligence']>>(form.intelligence, [
      'provider',
      'model',
      'baseUrl',
    ]),
    browser: pick<NonNullable<M['browser']>>(form.browser, [
      'url',
      'host',
      'port',
    ]),
    voice: pick<NonNullable<M['voice']>>(form.voice, ['model', 'name']),
    computers: pick<NonNullable<M['computers']>>(form.computers, [
      'namespace',
      'memoryBytes',
      'runtime',
      'engineSocket',
    ]),
    appOrigin: form.appOrigin?.trim() || undefined,
  };
}

function IntelligenceSection({
  config,
  formData,
  onChange,
}: {
  config: ConfigurationReadModel['sections']['intelligence'];
  formData?: ManagedConfiguration['intelligence'];
  onChange: (data: ManagedConfiguration['intelligence']) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(!!formData?.baseUrl);
  const provider: Provider = formData?.provider ?? 'anthropic';
  const meta = PROVIDERS[provider];
  // Status is known for the saved provider; a newly picked one is checked on save.
  const statusKnown = config.provider === provider;

  return (
    <div className="section">
      <h3>Intelligence Configuration</h3>
      <div className="form-group">
        <label>Provider *</label>
        <select
          value={provider}
          onChange={(e) =>
            onChange({ ...formData, provider: e.target.value as Provider })
          }
          className="setup-input"
        >
          {(Object.keys(PROVIDERS) as Provider[]).map((id) => (
            <option key={id} value={id}>
              {PROVIDERS[id].label}
            </option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label>Model *</label>
        <input
          type="text"
          placeholder={meta.modelPlaceholder}
          value={formData?.model || ''}
          onChange={(e) => onChange({ ...formData, model: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="secret-status">
        <strong>{meta.label.split(' ')[0]} credential:</strong>{' '}
        {statusKnown
          ? config.apiKey.configured
            ? '✓ Configured'
            : '○ Not configured'
          : 'checked when you save'}
        <small style={{ display: 'block', marginTop: 6 }}>
          Provider keys are never stored by OpenDots. Set{' '}
          <code>{meta.credentialVariable}</code> in the server environment (
          <code>.env</code>) and restart.
        </small>
      </div>

      <button
        type="button"
        className="text-button"
        onClick={() => setShowAdvanced(!showAdvanced)}
      >
        {showAdvanced ? 'Hide' : 'Show'} advanced settings
      </button>
      {showAdvanced && (
        <div className="form-group">
          <label>Base URL (Optional)</label>
          <input
            type="url"
            placeholder={meta.baseUrl}
            value={formData?.baseUrl || ''}
            onChange={(e) => onChange({ ...formData, baseUrl: e.target.value })}
            className="setup-input"
          />
        </div>
      )}
    </div>
  );
}

function BrowserSection({
  config,
  formData,
  onChange,
}: {
  config: ConfigurationReadModel['sections']['browser'];
  formData?: ManagedConfiguration['browser'];
  onChange: (data: ManagedConfiguration['browser']) => void;
}) {
  return (
    <div className="section">
      <h3>Browser Configuration</h3>
      <p className="section-help">Configure an optional browser service</p>
      <div className="form-group">
        <label>URL</label>
        <input
          type="url"
          placeholder="http://127.0.0.1:4311"
          value={formData?.url || ''}
          onChange={(e) => onChange({ ...formData, url: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Host</label>
        <input
          type="text"
          placeholder="127.0.0.1"
          value={formData?.host || ''}
          onChange={(e) => onChange({ ...formData, host: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Port</label>
        <input
          type="number"
          placeholder="4311"
          value={formData?.port || ''}
          onChange={(e) =>
            onChange({
              ...formData,
              port: e.target.value ? parseInt(e.target.value) : undefined,
            })
          }
          className="setup-input"
        />
      </div>
      <div className="secret-status">
        <strong>Browser Secret:</strong>{' '}
        {config.secret.configured ? '✓ Configured' : '○ Not configured'}
      </div>
    </div>
  );
}

function VoiceSection({
  config,
  formData,
  onChange,
}: {
  config: ConfigurationReadModel['sections']['voice'];
  formData?: ManagedConfiguration['voice'];
  onChange: (data: ManagedConfiguration['voice']) => void;
}) {
  return (
    <div className="section">
      <h3>Voice Configuration</h3>
      <p className="section-help">Configure optional voice services</p>
      <div className="form-group">
        <label>Model</label>
        <input
          type="text"
          placeholder="e.g., gpt-realtime"
          value={formData?.model || ''}
          onChange={(e) => onChange({ ...formData, model: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Voice Name</label>
        <input
          type="text"
          placeholder="marin"
          value={formData?.name || ''}
          onChange={(e) => onChange({ ...formData, name: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="secret-status">
        <strong>Voice API Key:</strong>{' '}
        {config.apiKey.configured ? '✓ Configured' : '○ Not configured'}
      </div>
    </div>
  );
}

function ComputersSection({
  config,
  formData,
  onChange,
}: {
  config: ConfigurationReadModel['sections']['computers'];
  formData?: ManagedConfiguration['computers'];
  onChange: (data: ManagedConfiguration['computers']) => void;
}) {
  return (
    <div className="section">
      <h3>Computer Services Configuration</h3>
      <p className="section-help">Configure optional computer services</p>
      <div className="form-group">
        <label>Namespace</label>
        <input
          type="text"
          placeholder="opendots"
          value={formData?.namespace || ''}
          onChange={(e) => onChange({ ...formData, namespace: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Memory (bytes)</label>
        <input
          type="number"
          placeholder="2147483648"
          value={formData?.memoryBytes || ''}
          onChange={(e) =>
            onChange({
              ...formData,
              memoryBytes: e.target.value
                ? parseInt(e.target.value)
                : undefined,
            })
          }
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Runtime</label>
        <input
          type="text"
          placeholder="runsc"
          value={formData?.runtime || ''}
          onChange={(e) => onChange({ ...formData, runtime: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Engine Socket</label>
        <input
          type="text"
          placeholder="/var/run/docker.sock"
          value={formData?.engineSocket || ''}
          onChange={(e) =>
            onChange({ ...formData, engineSocket: e.target.value })
          }
          className="setup-input"
        />
      </div>
      <div className="secret-status">
        <strong>Supervisor Token:</strong>{' '}
        {config.supervisorToken.configured
          ? '✓ Configured'
          : '○ Not configured'}
      </div>
      <div className="secret-status">
        <strong>Computer Token:</strong>{' '}
        {config.token.configured ? '✓ Configured' : '○ Not configured'}
      </div>
    </div>
  );
}
