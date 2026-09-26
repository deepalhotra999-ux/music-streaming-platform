// Admin V2 — Platform configuration (SUPER_ADMIN only).
// - Feature flags: list, upsert, delete.
// - Platform settings: typed editors mirroring the server's typed schema
//   (boolean / integer / string); unknown keys fall back to raw JSON.
// - Emergency controls: the `emergency.*` break-glass settings with
//   high-visibility styling and explicit confirmation. They take effect
//   immediately and every change is audited.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import { deleteFlag, listFlags, listSettings, setFlag, setSetting } from '../api/ops';
import type { FeatureFlag, PlatformSetting } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useConfirm } from '../components/ConfirmDialog';
import { RequireSuperAdmin } from '../components/PermissionGate';
import { formatDate } from '../utils/format';

export function PlatformConfigPage(): React.ReactNode {
  return (
    <RequireSuperAdmin>
      <PlatformConfigContent />
    </RequireSuperAdmin>
  );
}

// Mirrors the server's typed schema (services/api/src/modules/ops/settings.ts).
const SETTING_TYPES: Record<string, 'boolean' | 'integer' | 'string'> = {
  'emergency.maintenance_mode': 'boolean',
  'emergency.readonly_mode': 'boolean',
  'emergency.new_signups_enabled': 'boolean',
  'platform.maintenance_message': 'string',
  'platform.support_email': 'string',
};

const EMERGENCY_KEYS = [
  'emergency.maintenance_mode',
  'emergency.readonly_mode',
  'emergency.new_signups_enabled',
] as const;

function PlatformConfigContent(): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [settings, setSettings] = useState<PlatformSetting[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [flagKey, setFlagKey] = useState('');
  const [flagEnabled, setFlagEnabled] = useState(true);
  const [flagRollout, setFlagRollout] = useState('100');
  const [flagDescription, setFlagDescription] = useState('');
  const [settingDrafts, setSettingDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, s] = await Promise.all([listFlags(client), listSettings(client)]);
      setFlags(f);
      setSettings(s);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  function noteOk(message: string): void {
    setActionError(null);
    setActionOk(message);
  }

  function noteError(err: unknown): void {
    setActionOk(null);
    setActionError(apiErrorMessage(err));
  }

  async function handleSaveFlag(): Promise<void> {
    const key = flagKey.trim();
    if (!key) {
      setActionError('Flag key is required.');
      return;
    }
    const rollout = Number.parseInt(flagRollout, 10);
    if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100) {
      setActionError('Rollout percent must be between 0 and 100.');
      return;
    }
    try {
      await setFlag(client, key, {
        enabled: flagEnabled,
        rolloutPercent: rollout,
        description: flagDescription.trim() || undefined,
      });
      setFlagKey('');
      setFlagEnabled(true);
      setFlagRollout('100');
      setFlagDescription('');
      await load();
      noteOk(`Flag "${key}" saved.`);
    } catch (err) {
      noteError(err);
    }
  }

  async function handleDeleteFlag(flag: FeatureFlag): Promise<void> {
    const confirmed = await confirm({
      title: `Delete flag "${flag.key}"?`,
      message: 'Clients will fall back to their built-in defaults for this flag.',
      confirmLabel: 'Delete flag',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await deleteFlag(client, flag.key);
      await load();
      noteOk(`Flag "${flag.key}" deleted.`);
    } catch (err) {
      noteError(err);
    }
  }

  async function handleSaveSetting(setting: PlatformSetting): Promise<void> {
    const key = setting.key;
    const type = SETTING_TYPES[key];
    const raw = settingDrafts[key];
    let value: unknown;
    if (type === 'boolean') {
      value = raw === 'true';
    } else if (type === 'integer') {
      const parsed = Number.parseInt(raw ?? '', 10);
      if (!Number.isFinite(parsed)) {
        setActionError(`Setting "${key}" expects an integer.`);
        return;
      }
      value = parsed;
    } else if (type === 'string') {
      value = raw ?? '';
    } else {
      try {
        value = JSON.parse(raw ?? '');
      } catch {
        setActionError(`Setting "${key}" expects valid JSON.`);
        return;
      }
    }

    const isEmergency = (EMERGENCY_KEYS as readonly string[]).includes(key);
    if (isEmergency) {
      const confirmed = await confirm({
        title: `Change ${key}?`,
        message: `This is a break-glass control. The new value (${JSON.stringify(value)}) takes effect immediately for the whole platform and is audited.`,
        confirmLabel: `Set ${key}`,
        danger: true,
      });
      if (!confirmed) return;
    }
    try {
      await setSetting(client, key, value);
      await load();
      noteOk(`Setting "${key}" updated.`);
    } catch (err) {
      noteError(err);
    }
  }

  function draftValue(setting: PlatformSetting): string {
    if (setting.key in settingDrafts) return settingDrafts[setting.key];
    const value = setting.value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return value;
    return JSON.stringify(value ?? null);
  }

  function renderSettingEditor(setting: PlatformSetting): React.ReactNode {
    const type = SETTING_TYPES[setting.key];
    const key = setting.key;
    const value = draftValue(setting);
    if (type === 'boolean') {
      return (
        <select
          aria-label={key}
          value={value}
          onChange={(event) => setSettingDrafts((d) => ({ ...d, [key]: event.target.value }))}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    if (type === 'integer') {
      return (
        <input
          type="number"
          aria-label={key}
          value={value}
          onChange={(event) => setSettingDrafts((d) => ({ ...d, [key]: event.target.value }))}
        />
      );
    }
    return (
      <input
        type="text"
        aria-label={key}
        value={value}
        style={{ minWidth: 260 }}
        onChange={(event) => setSettingDrafts((d) => ({ ...d, [key]: event.target.value }))}
      />
    );
  }

  if (loading) return <LoadingState label="Loading platform configuration…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;

  const emergencySettings = (settings ?? []).filter((s) =>
    (EMERGENCY_KEYS as readonly string[]).includes(s.key),
  );
  const regularSettings = (settings ?? []).filter(
    (s) => !(EMERGENCY_KEYS as readonly string[]).includes(s.key),
  );

  return (
    <div>
      <div className="page-header">
        <h1>Platform</h1>
      </div>
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      {actionOk && (
        <div className="success-banner" role="status">
          {actionOk}
        </div>
      )}

      <section aria-label="Feature flags">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Feature flags
        </h2>
        {!flags || flags.length === 0 ? (
          <EmptyState message="No flags defined." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Enabled</th>
                  <th scope="col">Rollout %</th>
                  <th scope="col">Description</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {flags.map((flag) => (
                  <tr key={flag.key}>
                    <td className="mono">{flag.key}</td>
                    <td>
                      {flag.enabled ? (
                        <span className="badge badge-green">On</span>
                      ) : (
                        <span className="badge badge-gray">Off</span>
                      )}
                    </td>
                    <td>{flag.rolloutPercent}%</td>
                    <td>{flag.description ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(flag.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void handleDeleteFlag(flag)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card">
          <h2>New / update flag</h2>
          <div className="toolbar">
            <div className="field">
              <label htmlFor="flag-key">Key</label>
              <input
                id="flag-key"
                type="text"
                placeholder="e.g. rollout.new_player"
                value={flagKey}
                onChange={(event) => setFlagKey(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="flag-enabled">Enabled</label>
              <select
                id="flag-enabled"
                value={flagEnabled ? 'true' : 'false'}
                onChange={(event) => setFlagEnabled(event.target.value === 'true')}
              >
                <option value="true">On</option>
                <option value="false">Off</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="flag-rollout">Rollout %</label>
              <input
                id="flag-rollout"
                type="number"
                min={0}
                max={100}
                value={flagRollout}
                onChange={(event) => setFlagRollout(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="flag-description">Description</label>
              <input
                id="flag-description"
                type="text"
                value={flagDescription}
                onChange={(event) => setFlagDescription(event.target.value)}
              />
            </div>
            <button type="button" className="btn" onClick={() => void handleSaveFlag()}>
              Save flag
            </button>
          </div>
        </div>
      </section>

      <section aria-label="Emergency controls">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Emergency controls
        </h2>
        <div className="card danger-zone">
          <p className="muted">
            Break-glass controls. Changes take effect immediately platform-wide and are audited.
            Toggle carefully.
          </p>
          {emergencySettings.length === 0 ? (
            <EmptyState message="No emergency settings found." />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Control</th>
                    <th scope="col">Current</th>
                    <th scope="col">New value</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {emergencySettings.map((setting) => (
                    <tr key={setting.key}>
                      <td className="mono">{setting.key}</td>
                      <td className="mono">{JSON.stringify(setting.value)}</td>
                      <td>{renderSettingEditor(setting)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          onClick={() => void handleSaveSetting(setting)}
                        >
                          Apply
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section aria-label="Platform settings">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Settings
        </h2>
        {regularSettings.length === 0 ? (
          <EmptyState message="No settings." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Current</th>
                  <th scope="col">New value</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {regularSettings.map((setting) => (
                  <tr key={setting.key}>
                    <td className="mono">{setting.key}</td>
                    <td className="mono" style={{ maxWidth: 260 }}>
                      {JSON.stringify(setting.value)}
                    </td>
                    <td>{renderSettingEditor(setting)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(setting.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void handleSaveSetting(setting)}
                      >
                        Apply
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {dialog}
    </div>
  );
}
