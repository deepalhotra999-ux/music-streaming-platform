/**
 * Phase 3 authentication tests — full HTTP stack via `app.inject()`.
 * Runs against TEST_DATABASE_URL (see vitest.config.ts) — never the dev DB.
 *
 * Cleanup is scoped to `@auth-test.local` addresses so suites sharing the
 * test database never touch each other's rows (files also run sequentially).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { hashRefreshToken } from '../src/modules/auth/tokens.js';

const TEST_DOMAIN = '@auth-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase3-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;

async function scopedClean(): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { user: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
}

beforeAll(async () => {
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    // Generous limits for the functional suite; enforcement itself is
    // covered in rate-limit.test.ts with a dedicated low-limit app.
    RATE_LIMIT_LOGIN: '1000',
    RATE_LIMIT_REGISTER: '1000',
    RATE_LIMIT_REFRESH: '1000',
    RATE_LIMIT_LOGOUT: '1000',
  });
  app = await buildApp(config);
  await scopedClean();
});

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
});

async function register(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/auth/register', payload: body });
}

async function login(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/auth/login', payload: body });
}

function expectProblemJson(res: { headers: Record<string, unknown>; statusCode: number }) {
  expect(String(res.headers['content-type'])).toMatch('application/problem+json');
}

describe('registration', () => {
  it('creates a user and returns a token pair (201)', async () => {
    const body = { email: testEmail('reg'), password: PASSWORD, displayName: 'Reg User' };
    const res = await register(body);

    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.user.email).toBe(body.email);
    expect(json.user.displayName).toBe('Reg User');
    expect(json.user.role).toBe('LISTENER');
    expect(json.user.emailVerified).toBe(false);
    expect(json.tokens.tokenType).toBe('Bearer');
    expect(typeof json.tokens.accessToken).toBe('string');
    expect(typeof json.tokens.refreshToken).toBe('string');
    expect(json.tokens.expiresIn).toBe(config.accessTokenTtlSeconds);

    // The password hash must never appear in any API response.
    expect(JSON.stringify(json)).not.toContain('passwordHash');
    expect(JSON.stringify(json)).not.toContain(PASSWORD);

    // ...and must be a salted Argon2id hash at rest, not the plaintext.
    const row = await prisma.user.findUnique({ where: { email: body.email } });
    expect(row?.passwordHash).toBeTruthy();
    expect(row?.passwordHash).not.toBe(PASSWORD);
    expect(row?.passwordHash?.startsWith('$argon2id$')).toBe(true);
  });

  it('normalizes email case and rejects case-variant duplicates (409)', async () => {
    const emailAddr = testEmail('dupe');
    const first = await register({ email: emailAddr, password: PASSWORD, displayName: 'A' });
    expect(first.statusCode).toBe(201);

    const second = await register({
      email: emailAddr.toUpperCase(),
      password: PASSWORD,
      displayName: 'B',
    });
    expect(second.statusCode).toBe(409);
    expectProblemJson(second);
    expect(second.json().title).toBe('Conflict');
  });

  it('rejects invalid input with 400 problem+json', async () => {
    const badEmail = await register({
      email: 'not-an-email',
      password: PASSWORD,
      displayName: 'X',
    });
    expect(badEmail.statusCode).toBe(400);
    expectProblemJson(badEmail);
    expect(badEmail.json().errors.length).toBeGreaterThan(0);

    const shortPassword = await register({
      email: testEmail('short'),
      password: 'too-short-1',
      displayName: 'X',
    });
    expect(shortPassword.statusCode).toBe(400);

    const missingName = await register({ email: testEmail('noname'), password: PASSWORD });
    expect(missingName.statusCode).toBe(400);
  });
});

describe('login', () => {
  it('returns tokens for correct credentials (200)', async () => {
    const body = { email: testEmail('login'), password: PASSWORD, displayName: 'Login User' };
    await register(body);

    const res = await login({ email: body.email, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.user.email).toBe(body.email);
    expect(json.tokens.tokenType).toBe('Bearer');
    expect(JSON.stringify(json)).not.toContain('passwordHash');
  });

  it('accepts email in any case', async () => {
    const body = { email: testEmail('case'), password: PASSWORD, displayName: 'Case User' };
    await register(body);

    const res = await login({ email: body.email.toUpperCase(), password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it('returns identical 401s for wrong password and unknown email (no enumeration)', async () => {
    const body = { email: testEmail('wrong'), password: PASSWORD, displayName: 'Wrong User' };
    await register(body);

    const wrongPassword = await login({ email: body.email, password: 'wrong-password-123' });
    const unknownEmail = await login({
      email: testEmail('unknown'),
      password: 'wrong-password-123',
    });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.statusCode).toBe(401);
      expectProblemJson(res);
    }
    // Same shape, no hint about which half was wrong.
    expect(wrongPassword.json().title).toBe(unknownEmail.json().title);
    expect(wrongPassword.json().detail).toBe(unknownEmail.json().detail);
  });
});

describe('authenticated routes (guard)', () => {
  it('serves /v1/me with a valid token and 401s without one', async () => {
    const body = { email: testEmail('me'), password: PASSWORD, displayName: 'Me User' };
    const reg = await register(body);
    const token = reg.json().tokens.accessToken;

    const authed = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.statusCode).toBe(200);
    expect(authed.json().email).toBe(body.email);
    expect(JSON.stringify(authed.json())).not.toContain('passwordHash');

    const missing = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(missing.statusCode).toBe(401);
    expectProblemJson(missing);

    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Token abc' },
    });
    expect(malformed.statusCode).toBe(401);
  });

  it('rejects tampered and expired tokens', async () => {
    const body = { email: testEmail('tamper'), password: PASSWORD, displayName: 'Tamper User' };
    const reg = await register(body);
    const token: string = reg.json().tokens.accessToken;

    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    const tamperedRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(tamperedRes.statusCode).toBe(401);

    const secret = new TextEncoder().encode(config.jwtSecret);
    const expired = await new jose.SignJWT({ email: body.email, role: 'LISTENER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(reg.json().user.id)
      .setIssuer(config.jwtIssuer)
      .setAudience(config.jwtAudience)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(secret);
    const expiredRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(expiredRes.statusCode).toBe(401);
  });

  it('rejects /v1/me after the account is deleted', async () => {
    const body = { email: testEmail('deleted'), password: PASSWORD, displayName: 'Gone User' };
    const reg = await register(body);
    const token = reg.json().tokens.accessToken;

    await prisma.user.delete({ where: { id: reg.json().user.id } });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('refresh rotation', () => {
  it('rotates the refresh token: old dies, new works', async () => {
    const body = { email: testEmail('rotate'), password: PASSWORD, displayName: 'Rotate User' };
    const reg = await register(body);
    const tokenA: string = reg.json().tokens.refreshToken;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: tokenA },
    });
    expect(first.statusCode).toBe(200);
    const tokenB: string = first.json().tokens.refreshToken;
    expect(tokenB).not.toBe(tokenA);

    // The old token is dead...
    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: tokenA },
    });
    // ...and reusing a rotated token is treated as theft: the whole family,
    // including tokenB, is revoked.
    expect(reuse.statusCode).toBe(401);

    const afterTheft = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: tokenB },
    });
    expect(afterTheft.statusCode).toBe(401);

    // The user can still log in fresh afterwards.
    const relogin = await login({ email: body.email, password: PASSWORD });
    expect(relogin.statusCode).toBe(200);
  });

  it('rejects unknown and malformed refresh tokens with 401', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'a'.repeat(43) },
    });
    expect(unknown.statusCode).toBe(401);
    expectProblemJson(unknown);

    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'x' },
    });
    expect(malformed.statusCode).toBe(400);
  });
});

describe('logout', () => {
  it('revokes the refresh token and is idempotent', async () => {
    const body = { email: testEmail('logout'), password: PASSWORD, displayName: 'Logout User' };
    const reg = await register(body);
    const token: string = reg.json().tokens.refreshToken;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: token },
    });
    expect(res.statusCode).toBe(204);

    const after = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: token },
    });
    expect(after.statusCode).toBe(401);

    // Idempotent: logging out twice (or with an unknown token) still 204.
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: token },
    });
    expect(again.statusCode).toBe(204);

    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken: 'b'.repeat(43) },
    });
    expect(unknown.statusCode).toBe(204);
  });

  it('stores only the hash of refresh tokens', async () => {
    const body = { email: testEmail('opaque'), password: PASSWORD, displayName: 'Opaque User' };
    const reg = await register(body);
    const raw: string = reg.json().tokens.refreshToken;

    const row = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(raw) },
    });
    expect(row).not.toBeNull();
    // No row anywhere contains the raw token.
    expect(await prisma.refreshToken.count({ where: { tokenHash: raw } })).toBe(0);
  });
});

describe('platform', () => {
  it('exposes a health endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('returns 404 problem+json for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expectProblemJson(res);
  });
});
