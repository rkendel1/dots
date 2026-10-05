import { useEffect, useState } from 'react';
import { api } from './api';
import { AlertCircle, Check, Circle, Save, X } from 'lucide-react';
import type {
  ConfigurationReadModel,
  ManagedConfiguration,
} from '../shared/types';
import './setup-dialog.css';

interface SetupDialogProps {
  onComplete?: () => void;
  isOpen: boolean;
}

export function SetupDialog({ onComplete, isOpen }: SetupDialogProps) {
  const [config, setConfig] = useState<ConfigurationReadModel | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<
    'intelligence' | 'browser' | 'voice' | 'slack' | 'computers'
  >('intelligence');
  const [formData, setFormData] = useState<Partial<ManagedConfiguration>>({});

  // Load configuration on mount
  useEffect(() => {
    if (!isOpen) return;
    const loadConfig = async () => {
      try {
        const data = await api<ConfigurationReadModel>('/configuration');
        setConfig(data);
        setFormData({
          intelligence: data.sections.intelligence,
          browser: data.sections.browser,
          voice: data.sections.voice,
          slack: data.sections.slack,
          computers: data.sections.computers,
          appOrigin: data.sections.core.appOrigin,
        });
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Failed to load configuration',
        );
      }
    };
    void loadConfig();
  }, [isOpen]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api<ConfigurationReadModel>(
        '/configuration',
        'PUT',
        formData,
      );
      const updated = await api<ConfigurationReadModel>('/configuration');
      setConfig(updated);
      if (updated.setupComplete && onComplete) {
        onComplete();
      }
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
  const allConfigured = config.requirements.every(
    (r) => !r.required || r.configured,
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
          {/* Requirements Summary */}
          <div className="requirements-summary">
            <h2>Setup Status</h2>
            {config.requirements.map((req) => (
              <div key={req.id} className="requirement-item">
                <div className="requirement-status">
                  {req.configured ? (
                    <Check className="icon-check" size={16} />
                  ) : req.required ? (
                    <Circle className="icon-missing" size={16} />
                  ) : (
                    <Circle className="icon-optional" size={16} />
                  )}
                </div>
                <div className="requirement-label">
                  <span>{req.label}</span>
                  {req.required && !req.configured && (
                    <span className="required-badge">Required</span>
                  )}
                  {!req.required && <span className="optional-badge">Optional</span>}
                </div>
                <div className="requirement-source">
                  {req.source === 'environment' && (
                    <span className="source-env">Environment</span>
                  )}
                  {req.source === 'missing' && (
                    <span className="source-missing">Not configured</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Configuration Sections */}
          <div className="configuration-sections">
            <div className="section-tabs">
              {(['intelligence', 'browser', 'voice', 'slack', 'computers'] as const).map(
                (section) => (
                  <button
                    key={section}
                    className={`section-tab ${
                      activeSection === section ? 'active' : ''
                    }`}
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
              {activeSection === 'slack' && (
                <SlackSection
                  config={config.sections.slack}
                  formData={formData.slack}
                  onChange={(data) =>
                    setFormData({ ...formData, slack: data })
                  }
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

          {/* Core Settings */}
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
          {requiredMissing.length > 0 && (
            <div className="missing-count">
              {requiredMissing.length} required field(s) missing
            </div>
          )}
          <button
            className="setup-button"
            onClick={handleSave}
            disabled={saving || !allConfigured}
          >
            {saving ? 'Saving...' : 'Save Configuration'}
            {!saving && <Save size={16} />}
          </button>
        </div>

        {allConfigured && config.setupComplete && (
          <div className="setup-complete">
            <Check size={20} />
            <span>Setup Complete! You can now start using OpenDots.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function IntelligenceSection({
  config,
  formData,
  onChange,
}: {
  config: any;
  formData?: any;
  onChange: (data: any) => void;
}) {
  return (
    <div className="section">
      <h3>Intelligence Configuration</h3>
      <div className="form-group">
        <label>API URL (Optional)</label>
        <input
          type="url"
          placeholder="https://..."
          value={formData?.apiUrl || ''}
          onChange={(e) =>
            onChange({ ...formData, apiUrl: e.target.value })
          }
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>WebSocket URL (Optional)</label>
        <input
          type="url"
          placeholder="wss://..."
          value={formData?.wsUrl || ''}
          onChange={(e) => onChange({ ...formData, wsUrl: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Model (Optional)</label>
        <input
          type="text"
          placeholder="gpt-4"
          value={formData?.model || ''}
          onChange={(e) => onChange({ ...formData, model: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Base URL (Optional)</label>
        <input
          type="url"
          placeholder="https://api.openai.com/v1"
          value={formData?.baseUrl || ''}
          onChange={(e) =>
            onChange({ ...formData, baseUrl: e.target.value })
          }
          className="setup-input"
        />
      </div>
      <div className="secret-status">
        <strong>Intelligence API Key:</strong>{' '}
        {config?.apiKey?.configured ? '✓ Configured' : '○ Not configured'}
      </div>
    </div>
  );
}

function BrowserSection({
  config,
  formData,
  onChange,
}: {
  config: any;
  formData?: any;
  onChange: (data: any) => void;
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
        {config?.secret?.configured ? '✓ Configured' : '○ Not configured'}
      </div>
    </div>
  );
}

function VoiceSection({
  config,
  formData,
  onChange,
}: {
  config: any;
  formData?: any;
  onChange: (data: any) => void;
}) {
  return (
    <div className="section">
      <h3>Voice Configuration</h3>
      <p className="section-help">Configure optional voice services</p>
      <div className="form-group">
        <label>Model</label>
        <input
          type="text"
          placeholder="e.g., tts-1"
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
        {config?.apiKey?.configured ? '✓ Configured' : '○ Not configured'}
      </div>
    </div>
  );
}

function SlackSection({
  config,
  formData,
  onChange,
}: {
  config: any;
  formData?: any;
  onChange: (data: any) => void;
}) {
  return (
    <div className="section">
      <h3>Slack Configuration</h3>
      <p className="section-help">Configure optional Slack integration</p>
      <div className="form-group">
        <label>Channel Name</label>
        <input
          type="text"
          placeholder="opendots"
          value={formData?.channelName || ''}
          onChange={(e) =>
            onChange({ ...formData, channelName: e.target.value })
          }
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Team ID</label>
        <input
          type="text"
          placeholder="T1234567890"
          value={formData?.teamId || ''}
          onChange={(e) => onChange({ ...formData, teamId: e.target.value })}
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>User IDs (comma-separated)</label>
        <input
          type="text"
          placeholder="U1234567890,U0987654321"
          value={(formData?.userIds || []).join(',')}
          onChange={(e) =>
            onChange({
              ...formData,
              userIds: e.target.value
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
          className="setup-input"
        />
      </div>
      <div className="form-group">
        <label>Dot ID (Optional)</label>
        <input
          type="text"
          value={formData?.dotId || ''}
          onChange={(e) => onChange({ ...formData, dotId: e.target.value })}
          className="setup-input"
        />
      </div>
    </div>
  );
}

function ComputersSection({
  config,
  formData,
  onChange,
}: {
  config: any;
  formData?: any;
  onChange: (data: any) => void;
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
          onChange={(e) =>
            onChange({ ...formData, namespace: e.target.value })
          }
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
              memoryBytes: e.target.value ? parseInt(e.target.value) : undefined,
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
        {config?.supervisorToken?.configured ? '✓ Configured' : '○ Not configured'}
      </div>
      <div className="secret-status">
        <strong>Computer Token:</strong>{' '}
        {config?.token?.configured ? '✓ Configured' : '○ Not configured'}
      </div>
    </div>
  );
}
