// Phase 5 — persisted session helpers.
// A session is the signed-in user's profile plus the current token pair,
// stored as one JSON document under a versioned key.

import type { AuthResult, TokenPair, User } from '../api';
import type { KeyValueStorage } from './storage';

export interface Session {
  user: User;
  tokens: TokenPair;
}

const SESSION_KEY = 'com.waveform.session.v1';

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const session = value as { user?: unknown; tokens?: unknown };
  const tokens = session.tokens as { accessToken?: unknown; refreshToken?: unknown } | undefined;
  const user = session.user as { id?: unknown; email?: unknown } | undefined;
  return (
    typeof user?.id === 'string' &&
    typeof user?.email === 'string' &&
    typeof tokens?.accessToken === 'string' &&
    typeof tokens?.refreshToken === 'string'
  );
}

export function sessionFromAuthResult(result: AuthResult): Session {
  return { user: result.user, tokens: result.tokens };
}

export async function loadSession(storage: KeyValueStorage): Promise<Session | null> {
  const raw = await storage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    // Corrupt data must never crash startup; treat as signed out.
    return null;
  }
}

export async function saveSession(storage: KeyValueStorage, session: Session): Promise<void> {
  await storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function clearSession(storage: KeyValueStorage): Promise<void> {
  await storage.removeItem(SESSION_KEY);
}
