// Phase 19 — Google service-account OAuth2.
//
// The Play Developer API is called with an OAuth2 access token minted from
// the configured service account (JSON key). Tokens are cached in memory
// until shortly before expiry; the private key never leaves this module.

import * as jose from 'jose';
import { serviceUnavailable, unprocessableEntity } from '../../../http/errors.js';
import type { FetchImpl } from '../fetchOverride.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export interface GoogleServiceAccount {
  clientEmail: string;
  privateKeyPem: string;
}

/** Parse the configured service-account JSON (inline or file contents). */
export function parseServiceAccount(raw: string): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unprocessableEntity('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw unprocessableEntity('GOOGLE_SERVICE_ACCOUNT_JSON must be a JSON object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.client_email !== 'string' || typeof obj.private_key !== 'string') {
    throw unprocessableEntity(
      'GOOGLE_SERVICE_ACCOUNT_JSON must contain "client_email" and "private_key".',
    );
  }
  return { clientEmail: obj.client_email, privateKeyPem: obj.private_key };
}

/** Mints and caches OAuth2 access tokens for the Play Developer API. */
export class GoogleAuth {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: GoogleServiceAccount,
    private readonly fetchImpl: FetchImpl,
  ) {}

  async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.token;
    }
    const privateKey = await jose.importPKCS8(this.account.privateKeyPem, 'RS256');
    const assertion = await new jose.SignJWT({ scope: ANDROID_PUBLISHER_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.account.clientEmail)
      .setSubject(this.account.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    if (!res.ok) {
      throw serviceUnavailable(`Google OAuth2 token request failed (HTTP ${res.status}).`);
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') {
      throw serviceUnavailable('Google OAuth2 token response was malformed.');
    }
    const expiresIn =
      typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? body.expires_in
        : 3600;
    this.cached = { token: body.access_token, expiresAt: now + expiresIn * 1000 };
    return body.access_token;
  }
}
