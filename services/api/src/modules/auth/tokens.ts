// Phase 3 — authentication. Token issuance primitives.
// Access: short-lived HS256 JWT. Refresh: opaque 256-bit random, stored as
// SHA-256 so a database read never yields a usable token (see ADR-003).

import { createHash, randomBytes } from 'node:crypto';
import * as jose from 'jose';
import type { Config } from '../../config.js';

export interface TokenSubject {
  id: string;
  email: string;
  role: string;
}

export async function createAccessToken(user: TokenSubject, config: Config): Promise<string> {
  const secret = new TextEncoder().encode(config.jwtSecret);
  return new jose.SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(secret);
}

/** One-time-display opaque token; the caller persists only its hash. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
