// Phase 16 — session state for the admin webapp.
//
// Uses the EXISTING auth system (POST /v1/auth/login, /refresh, /logout,
// GET /v1/me) — this phase does NOT create a second authorization system.
// Tokens live in localStorage; the ApiClient injects the Bearer header and
// performs one 401 → refresh → retry per request. The server remains the
// authority on roles; RequireAdmin is UX-only.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiClient, apiErrorMessage } from '../api/client';
import { getMe, login as apiLogin, logout as apiLogout, refreshTokens } from '../api/auth';
import type { AdminUser } from '../api/types';

const ACCESS_TOKEN_KEY = 'waveform.admin.accessToken';
const REFRESH_TOKEN_KEY = 'waveform.admin.refreshToken';

export interface AuthState {
  user: AdminUser | null;
  isAdmin: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  /** Shared API client for the current session. */
  client: ApiClient;
}

const AuthContext = createContext<AuthState | null>(null);

function readStoredTokens(): { access: string | null; refresh: string | null } {
  try {
    return {
      access: localStorage.getItem(ACCESS_TOKEN_KEY),
      refresh: localStorage.getItem(REFRESH_TOKEN_KEY),
    };
  } catch {
    return { access: null, refresh: null };
  }
}

function storeTokens(access: string, refresh: string): void {
  try {
    localStorage.setItem(ACCESS_TOKEN_KEY, access);
    localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
  } catch {
    // Storage unavailable (private mode); session still works in memory.
  }
}

function clearStoredTokens(): void {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const userRef = useRef<AdminUser | null>(null);
  userRef.current = user;

  // Sign-out helper that can be referenced from the refresh callback without
  // stale closures.
  const signOutLocal = useCallback(() => {
    clearStoredTokens();
    setUser(null);
  }, []);

  const client = useMemo(() => {
    const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
    // Plain client for the refresh call itself — it must not recurse into
    // the refresh logic.
    const refreshOnly = new ApiClient({ baseUrl });
    return new ApiClient({
      baseUrl,
      getAccessToken: () => readStoredTokens().access,
      onTokenRefresh: async () => {
        const { refresh } = readStoredTokens();
        if (!refresh) return null;
        try {
          const { tokens, user: refreshedUser } = await refreshTokens(refreshOnly, refresh);
          storeTokens(tokens.accessToken, tokens.refreshToken);
          if (refreshedUser && !userRef.current) {
            setUser(refreshedUser);
          }
          return tokens.accessToken;
        } catch {
          signOutLocal();
          return null;
        }
      },
    });
  }, [signOutLocal]);

  // Bootstrap: if tokens are stored, validate them via GET /v1/me.
  useEffect(() => {
    let cancelled = false;
    async function bootstrap(): Promise<void> {
      const { access } = readStoredTokens();
      if (!access) {
        setIsLoading(false);
        return;
      }
      try {
        const me = await getMe(client);
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) signOutLocal();
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [client, signOutLocal]);

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        const result = await apiLogin(client, { email, password });
        storeTokens(result.tokens.accessToken, result.tokens.refreshToken);
        // Re-fetch /v1/me so the identity comes from the authoritative
        // endpoint, not just the login response payload.
        const me = await getMe(client);
        setUser(me);
      } catch (err) {
        signOutLocal();
        const message = apiErrorMessage(err);
        setError(message);
        throw new Error(message);
      }
    },
    [client, signOutLocal],
  );

  const logout = useCallback(async () => {
    const { refresh } = readStoredTokens();
    clearStoredTokens();
    setUser(null);
    if (refresh) {
      // Best-effort server-side revocation; never blocks local sign-out.
      try {
        await apiLogout(client, refresh);
      } catch {
        // ignore
      }
    }
  }, [client]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      isAdmin: user?.role === 'ADMIN',
      isLoading,
      error,
      login,
      logout,
      clearError,
      client,
    }),
    [user, isLoading, error, login, logout, clearError, client],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Route guard. The server is the real authority (every admin endpoint is
 * ADMIN-guarded backend-side); this only shapes the UX:
 * - not signed in → /login
 * - signed in as LISTENER/ARTIST → explicit "Access denied — admin only"
 *   screen with a logout button (no redirect loop, no silent bounce).
 */
export function RequireAdmin({ children }: { children: ReactNode }): ReactNode {
  const { user, isAdmin, isLoading, logout } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="center-screen">
        <div className="spinner" aria-label="Loading" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (!isAdmin) {
    return (
      <div className="center-screen">
        <div className="card access-denied">
          <h1>Access denied — admin only</h1>
          <p>
            You are signed in as <strong>{user.displayName}</strong> ({user.role}), but this console
            requires an ADMIN account. The backend enforces this on every admin endpoint.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void logout();
            }}
          >
            Log out
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
