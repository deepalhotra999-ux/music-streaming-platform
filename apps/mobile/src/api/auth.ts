// Phase 5 — auth endpoints against the Phase 3/4 API.
// Thin wrappers over ApiClient; session lifecycle lives in src/auth.

import type { ApiClient } from './client';
import type { AuthResult, LoginInput, RegisterInput, User } from './types';

export async function register(client: ApiClient, input: RegisterInput): Promise<AuthResult> {
  return client.post<AuthResult>('/v1/auth/register', input, { auth: false });
}

export async function login(client: ApiClient, input: LoginInput): Promise<AuthResult> {
  return client.post<AuthResult>('/v1/auth/login', input, { auth: false });
}

/** Rotates the refresh token; reuse revokes the whole token family. */
export async function refreshTokens(client: ApiClient, refreshToken: string): Promise<AuthResult> {
  return client.post<AuthResult>('/v1/auth/refresh', { refreshToken }, { auth: false });
}

/** Best-effort server-side revocation; local sign-out must not depend on it. */
export async function logout(client: ApiClient, refreshToken: string): Promise<void> {
  await client.post<void>('/v1/auth/logout', { refreshToken }, { auth: false });
}

/** Validates the current access token and returns the account profile. */
export async function getMe(client: ApiClient): Promise<User> {
  return client.get<User>('/v1/me');
}
