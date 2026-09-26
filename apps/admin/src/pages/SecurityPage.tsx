// Admin V2 — Security: platform security overview, active sessions with
// revocation, and global session revocation. Everything here is real data
// from the ops endpoints; the server re-authorizes every action.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import { getSecurityOverview, listActiveSessions, revokeActiveSession } from '../api/ops';
import type { AdminSession, SecurityOverview } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useConfirm } from '../components/ConfirmDialog';
import { RequirePermission } from '../components/PermissionGate';
import { formatDate } from '../utils/format';

export function SecurityPage(): React.ReactNode {
  return (
    <RequirePermission perm="security.view">
      <SecurityContent />
    </RequirePermission>
  );
}

function SecurityContent(): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, sess] = await Promise.all([
        getSecurityOverview(client),
        listActiveSessions(client),
      ]);
      setOverview(ov);
      setSessions(sess);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRevokeSession(session: AdminSession): Promise<void> {
    setActionError(null);
    setActionOk(null);
    const confirmed = await confirm({
      title: 'Revoke this session?',
      message: 'The device behind this session will be signed out immediately.',
      confirmLabel: 'Revoke session',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await revokeActiveSession(client, session.id);
      setSessions((prev) => prev?.filter((s) => s.id !== session.id) ?? prev);
      setActionOk('Session revoked.');
    } catch (err) {
      setActionError(apiErrorMessage(err));
    }
  }

  if (loading) return <LoadingState label="Loading security overview…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!overview) return <EmptyState message="No security data." />;

  return (
    <div>
      <div className="page-header">
        <h1>Security</h1>
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

      <div className="stat-grid">
        <div className="card stat-card">
          <p className="stat-value">{overview.logins24h.total}</p>
          <p className="stat-label">Logins (24h)</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{overview.logins24h.failed}</p>
          <p className="stat-label">Failed logins (24h)</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{overview.activeSessions}</p>
          <p className="stat-label">Active sessions</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{overview.bannedUsers}</p>
          <p className="stat-label">Banned users</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{overview.lockedOutIps24h}</p>
          <p className="stat-label">Locked-out IPs (24h)</p>
        </div>
        <div className="card stat-card">
          <p className="stat-value">{overview.rateLimitHits}</p>
          <p className="stat-label">Rate-limit hits</p>
        </div>
      </div>

      <div className="card">
        <h2>Top failed-login emails</h2>
        {overview.topFailedEmails.length === 0 ? (
          <p className="muted">None in the last 24 hours.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Failures</th>
                </tr>
              </thead>
              <tbody>
                {overview.topFailedEmails.map((row) => (
                  <tr key={row.email}>
                    <td className="mono">{row.email}</td>
                    <td>{row.failures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Active sessions ({sessions?.length ?? 0})</h2>
        {!sessions || sessions.length === 0 ? (
          <EmptyState message="No active sessions." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Created</th>
                  <th scope="col">Expires</th>
                  <th scope="col">IP</th>
                  <th scope="col">User agent</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(session.createdAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(session.expiresAt)}</td>
                    <td className="mono">{session.ipAddress ?? '—'}</td>
                    <td className="muted" style={{ maxWidth: 280 }}>
                      {session.userAgent ?? '—'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => void handleRevokeSession(session)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card danger-zone">
        <h2>Break-glass controls</h2>
        <p className="muted">
          Emergency controls (maintenance mode, read-only mode, disabling new signups) live under{' '}
          <Link to="/platform">Platform → Emergency controls</Link>. They take effect immediately
          and every change is audited.
        </p>
      </div>
      {dialog}
    </div>
  );
}
