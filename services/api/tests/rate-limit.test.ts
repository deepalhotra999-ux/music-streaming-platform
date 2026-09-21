/**
 * Phase 3 — rate limiting. A dedicated low-limit app proves the
 * @fastify/rate-limit wiring actually throttles auth endpoints.
 * (The functional suite in auth.test.ts runs with generous limits.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    RATE_LIMIT_LOGIN: '3',
    RATE_LIMIT_WINDOW_MS: '60000',
  });
  app = await buildApp(config);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('rate limiting', () => {
  it('returns 429 problem+json after exceeding the login limit', async () => {
    const payload = { email: 'ratelimited@auth-test.local', password: 'wrong-password-123' };
    const statuses: number[] = [];
    let last: InjectResponse | null = null;

    for (let i = 0; i < 4; i++) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload });
      statuses.push(res.statusCode);
      last = res;
    }

    // First 3 attempts run the handler (401: unknown email); the 4th is cut
    // off by the limiter before the handler runs.
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
    expect(String(last!.headers['content-type'])).toMatch('application/problem+json');
    expect(last!.json().title).toBe('Too Many Requests');
  });
});
