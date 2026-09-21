// Phase 16 — auth endpoints. Thin wrappers; session lifecycle lives in
// src/auth/AuthContext.tsx. The token pair is stored in localStorage there
// (keyed constants), never in these wrappers.

import type { ApiClient } from './client';
import type { AdminUser, AuthResult, LoginInput, TokenPair } from './types';

export async function login(client: ApiClient, input: LoginInput): Promise<AuthResult> {
  return client.post<AuthResult>('/v1/auth/login', input, { auth: false });
}

export interface RefreshResponse {
  user?: AdminUser;
  tokens: TokenPair;
}

/**
 * Rotates the refresh token; reuse revokes the whole token family.
 * The backend may return either a full AuthResult or just the new pair —
 * callers keep the existing user when it is absent.
 */
export async function refreshTokens(
  client: ApiClient,
  refreshToken: string,
): Promise<RefreshResponse> {
  return client.post<RefreshResponse>('/v1/auth/refresh', { refreshToken }, { auth: false });
}

/** Best-effort server-side revocation; local sign-out must not depend on it. */
export async function logout(client: ApiClient, refreshToken: string): Promise<void> {
  await client.post<unknown>('/v1/auth/logout', { refreshToken }, { auth: false });
}

/** Validates the current access token and returns the account profile. */
export async function getMe(client: ApiClient): Promise<AdminUser> {
  return client.get<AdminUser>('/v1/me');
}
