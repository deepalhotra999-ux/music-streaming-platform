// Phase 5 — authentication state for the whole app.
//
// - Restores the persisted session on launch and validates it against
//   GET /v1/me (refreshing once when the access token expired).
// - Owns the single ApiClient: it injects the current access token and
//   rotates the pair transparently on 401 via onTokenRefresh.
// - signOut revokes server-side best-effort, then ALWAYS clears local
//   state so the user can never get stuck signed in.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ApiClient,
  ApiError,
  getApiBaseUrl,
  getMe,
  login as apiLogin,
  logout as apiLogout,
  refreshTokens as apiRefreshTokens,
  register as apiRegister,
} from '../api';
import type { User } from '../api';
import { clearSession, loadSession, saveSession, sessionFromAuthResult } from './session';
import type { Session } from './session';
import { createSecureStorage } from './storage';
import type { KeyValueStorage } from './storage';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  /** Null while loading or signed out. */
  session: Session | null;
  user: User | null;
  /** Authenticated API client for screens (tokens injected automatically). */
  api: ApiClient;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return value;
}

interface AuthProviderProps {
  children: ReactNode;
  /** Injected for tests; defaults to expo-secure-store. */
  storage?: KeyValueStorage;
  /** Injected for tests; defaults to getApiBaseUrl(). */
  baseUrl?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export function AuthProvider({ children, storage, baseUrl, fetchFn }: AuthProviderProps) {
  const storageRef = useRef<KeyValueStorage>(storage ?? createSecureStorage());
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  // Ref mirror so the client's token callbacks never capture stale state.
  const sessionRef = useRef<Session | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setSessionState = useCallback((next: Session | null) => {
    sessionRef.current = next;
    if (mountedRef.current) {
      setSession(next);
      setStatus(next ? 'authenticated' : 'unauthenticated');
    }
  }, []);

  const persistSession = useCallback(
    async (next: Session) => {
      await saveSession(storageRef.current, next);
      setSessionState(next);
    },
    [setSessionState],
  );

  // A second, unauthenticated client for the token endpoints themselves so a
  // refresh call can never recurse into onTokenRefresh.
  const tokenClient = useMemo(
    () => new ApiClient({ baseUrl: baseUrl ?? getApiBaseUrl(), fetchFn }),
    [baseUrl, fetchFn],
  );

  const handleTokenRefresh = useCallback(async (): Promise<string | null> => {
    const current = sessionRef.current;
    if (!current) {
      return null;
    }
    try {
      const result = await apiRefreshTokens(tokenClient, current.tokens.refreshToken);
      const next = sessionFromAuthResult(result);
      // Persist the rotated pair; a failure here must not break the retry,
      // the in-memory session is already correct.
      await saveSession(storageRef.current, next).catch(() => undefined);
      setSessionState(next);
      return next.tokens.accessToken;
    } catch {
      // Refresh token invalid/rotated elsewhere: drop the session.
      await clearSession(storageRef.current).catch(() => undefined);
      setSessionState(null);
      return null;
    }
  }, [tokenClient, setSessionState]);

  const api = useMemo(
    () =>
      new ApiClient({
        baseUrl: baseUrl ?? getApiBaseUrl(),
        fetchFn,
        getAccessToken: () => sessionRef.current?.tokens.accessToken ?? null,
        onTokenRefresh: handleTokenRefresh,
      }),
    [baseUrl, fetchFn, handleTokenRefresh],
  );

  // Restore + validate the persisted session on launch.
  // Defined before the mount effect that uses it.
  const refreshStoredSession = useCallback(
    async (stored: Session): Promise<Session | null> => {
      sessionRef.current = stored;
      const accessToken = await handleTokenRefresh();
      return accessToken ? sessionRef.current : null;
    },
    [handleTokenRefresh],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadSession(storageRef.current).catch(() => null);
      if (!stored) {
        if (!cancelled) {
          setSessionState(null);
        }
        return;
      }
      sessionRef.current = stored;
      try {
        const probe = new ApiClient({
          baseUrl: baseUrl ?? getApiBaseUrl(),
          fetchFn,
          getAccessToken: () => stored.tokens.accessToken,
        });
        const user = await getMe(probe);
        if (!cancelled) {
          setSessionState({ user, tokens: stored.tokens });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (error instanceof ApiError && error.isUnauthorized) {
          // Access token expired: one refresh attempt before giving up.
          const refreshed = await refreshStoredSession(stored);
          if (!cancelled) {
            setSessionState(refreshed);
          }
        } else {
          // Network or server failure at launch: keep the stored session so
          // the user is not signed out by a flaky connection. Screens will
          // surface errors and the client's 401 hook refreshes on demand.
          if (!cancelled) {
            setSessionState(stored);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Intentionally runs once on mount; callbacks are stable.
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await apiLogin(tokenClient, { email, password });
      await persistSession(sessionFromAuthResult(result));
    },
    [tokenClient, persistSession],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      const result = await apiRegister(tokenClient, { email, password, displayName });
      await persistSession(sessionFromAuthResult(result));
    },
    [tokenClient, persistSession],
  );

  const signOut = useCallback(async () => {
    const current = sessionRef.current;
    if (current) {
      // Best-effort server revocation; local sign-out proceeds regardless.
      await apiLogout(tokenClient, current.tokens.refreshToken).catch(() => undefined);
    }
    await clearSession(storageRef.current).catch(() => undefined);
    setSessionState(null);
  }, [tokenClient, setSessionState]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      user: session?.user ?? null,
      api,
      signIn,
      signUp,
      signOut,
    }),
    [status, session, api, signIn, signUp, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
