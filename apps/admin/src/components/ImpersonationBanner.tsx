// Admin V2 — persistent impersonation warning banner.
//
// Rendered at the top of the admin shell whenever the stored access token
// decodes (display-only) to an impersonation session. Shows the reason and
// a live countdown, with an explicit "End impersonation" button that calls
// POST /v1/admin/impersonation/end and then signs out locally. The banner
// can never be dismissed while the session is active — closing it requires
// ending the session.

import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { endImpersonation } from '../api/ops';
import {
  decodeImpersonationClaims,
  formatCountdown,
  impersonationSecondsLeft,
} from '../auth/impersonation';

/** Must match the key in auth/AuthContext.tsx. */
export const ACCESS_TOKEN_KEY = 'waveform.admin.accessToken';

export function ImpersonationBanner(): React.ReactNode {
  const { client, logout } = useAuth();
  const [claims, setClaims] = useState(() =>
    decodeImpersonationClaims(localStorage.getItem(ACCESS_TOKEN_KEY)),
  );
  const [now, setNow] = useState(Date.now());
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  // Re-check the stored token periodically: impersonation starts by swapping
  // the stored token, and expiry should surface without a reload.
  useEffect(() => {
    const id = window.setInterval(() => {
      setClaims(decodeImpersonationClaims(localStorage.getItem(ACCESS_TOKEN_KEY)));
      setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!claims) return null;

  const secondsLeft = impersonationSecondsLeft(claims, now);

  async function handleEnd(): Promise<void> {
    setEnding(true);
    setEndError(null);
    try {
      await endImpersonation(client);
    } catch {
      // Best effort: even if the server call fails (e.g. already expired),
      // the local session must be dropped.
    } finally {
      await logout();
      window.location.hash = '#/login';
      window.location.reload();
    }
  }

  return (
    <div className="impersonation-banner" role="alert" aria-live="assertive">
      <div className="impersonation-banner-main">
        <strong>IMPERSONATING</strong>
        <span className="mono">{claims.email}</span>
        <span className="impersonation-reason" title={claims.reason}>
          {claims.reason}
        </span>
        <span className="mono" aria-label="Time remaining">
          expires in {formatCountdown(secondsLeft)}
        </span>
      </div>
      <div className="impersonation-banner-actions">
        {endError && <span className="error-text">{endError}</span>}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={ending}
          onClick={() => void handleEnd()}
        >
          {ending ? 'Ending…' : 'End impersonation'}
        </button>
      </div>
    </div>
  );
}
