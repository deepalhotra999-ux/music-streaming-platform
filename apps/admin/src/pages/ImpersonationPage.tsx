// Admin V2 — impersonation (SUPER_ADMIN only).
//
// Starts a short-lived impersonation session for support/debugging. The
// returned token replaces the stored access token and the page reloads;
// the persistent ImpersonationBanner (in the shell) then shows the reason,
// a live countdown, and the only way out. Ending the session signs the
// admin out locally — the original admin session is not restorable, by
// design. The server enforces duration, target eligibility, and the
// admin-route block on every request.

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { startImpersonation } from '../api/ops';
import { EmptyState, ErrorState } from '../components/DataStates';
import { useConfirm } from '../components/ConfirmDialog';
import { RequireSuperAdmin } from '../components/PermissionGate';
import { useReason } from '../components/ReasonDialog';
import { ACCESS_TOKEN_KEY } from '../components/ImpersonationBanner';
import { decodeImpersonationClaims } from '../auth/impersonation';

const REFRESH_TOKEN_KEY = 'waveform.admin.refreshToken';

export function ImpersonationPage(): React.ReactNode {
  return (
    <RequireSuperAdmin>
      <ImpersonationContent />
    </RequireSuperAdmin>
  );
}

function ImpersonationContent(): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { askReason, dialog: reasonDialog } = useReason();
  const [targetUserId, setTargetUserId] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('5');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const activeClaims = decodeImpersonationClaims(
    (() => {
      try {
        return localStorage.getItem(ACCESS_TOKEN_KEY);
      } catch {
        return null;
      }
    })(),
  );

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const target = targetUserId.trim();
    if (!target) {
      setError(new Error('Enter the target user ID.'));
      return;
    }
    const minutes = Number.parseInt(durationMinutes, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 30) {
      setError(new Error('Duration must be between 1 and 30 minutes.'));
      return;
    }
    const reason = await askReason({
      title: 'Start impersonation?',
      message: `You will act as user ${target} for up to ${minutes} minutes. Every action you take is attributed to you in the audit log, and admin routes stay blocked. Use this only for support or debugging.`,
      reasonPlaceholder: 'Why are you impersonating this user? (required)…',
      confirmLabel: 'Start impersonation',
    });
    if (!reason) return;
    const confirmed = await confirm({
      title: 'Swap your session now?',
      message:
        'Your current admin session will be replaced by the impersonation session. When it ends (or expires) you will be signed out and must sign in again. This cannot be undone.',
      confirmLabel: 'Swap session',
      danger: true,
    });
    if (!confirmed) return;
    setStarting(true);
    setError(null);
    try {
      const session = await startImpersonation(client, {
        targetUserId: target,
        reason,
        durationMinutes: minutes,
      });
      // Swap the stored access token for the impersonation token. The
      // refresh token is dropped: impersonation sessions cannot refresh.
      try {
        localStorage.setItem(ACCESS_TOKEN_KEY, session.token);
        localStorage.removeItem(REFRESH_TOKEN_KEY);
      } catch {
        setError(new Error('Could not store the impersonation token (storage unavailable).'));
        setStarting(false);
        return;
      }
      window.location.reload();
    } catch (err) {
      setError(err);
      setStarting(false);
    }
  }

  return (
    <div>
      {confirmDialog}
      {reasonDialog}
      <div className="page-header">
        <h1>Impersonate</h1>
      </div>
      {activeClaims && (
        <div className="error-banner" role="alert">
          An impersonation session is already active ({activeClaims.email}). End it from the banner
          at the top of the page before starting another.
        </div>
      )}
      <div className="card">
        <h2>Start impersonation session</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          SUPER_ADMIN only. Target must be a non-admin, non-banned user. Sessions last 1–30 minutes
          and can never reach <span className="mono">/v1/admin/*</span>.
        </p>
        {Boolean(error) && <ErrorState error={error} onRetry={() => setError(null)} />}
        <form onSubmit={(event) => void handleSubmit(event)}>
          <div className="field">
            <label htmlFor="impersonate-target">Target user ID</label>
            <input
              id="impersonate-target"
              type="text"
              className="mono"
              value={targetUserId}
              onChange={(event) => setTargetUserId(event.target.value)}
              placeholder="User UUID (copy from Users or Search)"
              required
              disabled={starting || !!activeClaims}
            />
          </div>
          <div className="field">
            <label htmlFor="impersonate-duration">Duration (minutes, max 30)</label>
            <input
              id="impersonate-duration"
              type="number"
              min={1}
              max={30}
              value={durationMinutes}
              onChange={(event) => setDurationMinutes(event.target.value)}
              disabled={starting || !!activeClaims}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={starting || !targetUserId.trim() || !!activeClaims}
          >
            {starting ? 'Starting…' : 'Start impersonation'}
          </button>
        </form>
      </div>
      <div className="card">
        <h2>How it works</h2>
        {activeClaims ? (
          <EmptyState message="Session active — see the banner above for the countdown and exit." />
        ) : (
          <p className="muted" style={{ fontSize: 13 }}>
            No active impersonation session. Starting one swaps your access token; the persistent
            banner appears at the top of every admin page until the session ends or expires, at
            which point you are signed out.
          </p>
        )}
      </div>
    </div>
  );
}
