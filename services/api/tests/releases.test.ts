/**
 * Release tooling — admin deploy surface tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB). The GitHub API is stubbed via `vi.stubGlobal('fetch', ...)` so
 * no test ever touches the network.
 *
 * Covers:
 * - POST /v1/admin/deploy: 202 dispatch with correct GitHub request shape
 *   (URL, Bearer token, event_type, client_payload ref), audit row written
 *   on success only (facts only — never the token), 400 on bad ref,
 *   401 unauthenticated, 403 for LISTENER, 503 when the token is not
 *   configured, 502 when GitHub rejects the dispatch.
 * - GET /v1/admin/deploy/runs: 200 with mapped run fields, 401/403, 503
 *   when not configured.
 *
 * Audit rows are append-only (DB trigger rejects DELETE), so assertions
 * scope to a unique ref per run instead of cleaning up.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';

const TEST_DOMAIN = '@releases-test.local';
let counter = 0;
const testEmail = (tag: string) => `releases-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';
const TEST_TOKEN = 'ghp_test-deploy-token';
const UNIQUE_REF = `testref-${Date.now()}`;

let app: FastifyInstance; // GITHUB_DEPLOY_TOKEN configured
let appNoToken: FastifyInstance; // not configured

type Role = 'LISTENER' | 'ADMIN';

async function registerAndLogin(
  target: FastifyInstance,
  email: string,
  role: Role,
): Promise<{ userId: string; token: string }> {
  const reg = await target.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: email },
  });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().user.id as string;
  if (role !== 'LISTENER') {
    await prisma.user.update({ where: { id: userId }, data: { role } });
  }
  const login = await target.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return { userId, token: login.json().tokens.accessToken as string };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let admin: { userId: string; token: string };
let listener: { userId: string; token: string };
let adminNoToken: { userId: string; token: string };

const mockFetch = vi.fn();

function stubDispatch(status: number) {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ status, ok: status >= 200 && status < 300 });
}

function stubRuns(runs: unknown[]) {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({ workflow_runs: runs }),
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', mockFetch);

  // Unconfigured app first: the token must be absent when its config loads.
  delete process.env.GITHUB_DEPLOY_TOKEN;
  appNoToken = await buildApp(loadConfig());

  process.env.GITHUB_DEPLOY_TOKEN = TEST_TOKEN;
  app = await buildApp(loadConfig());

  admin = await registerAndLogin(app, testEmail('admin'), 'ADMIN');
  listener = await registerAndLogin(app, testEmail('listener'), 'LISTENER');
  adminNoToken = await registerAndLogin(appNoToken, testEmail('admin2'), 'ADMIN');
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_DEPLOY_TOKEN;
  await app.close();
  await appNoToken.close();
  await prisma.$disconnect();
});

describe('POST /v1/admin/deploy', () => {
  it('dispatches to GitHub and returns 202 with an audit row', async () => {
    stubDispatch(204);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/deploy',
      headers: auth(admin.token),
      payload: { ref: UNIQUE_REF },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      dispatched: true,
      ref: UNIQUE_REF,
      eventType: 'deploy-requested',
    });

    // GitHub request shape: correct endpoint, Bearer token, event payload.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.github.com/repos/deepalhotra999-ux/music-streaming-platform/dispatches',
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers.Accept).toBe('application/vnd.github+json');
    const body = JSON.parse(init.body as string) as {
      event_type: string;
      client_payload: { ref: string };
    };
    expect(body.event_type).toBe('deploy-requested');
    expect(body.client_payload.ref).toBe(UNIQUE_REF);

    // Audit row: facts only, never the token.
    const rows = await prisma.adminAuditLog.findMany({
      where: { action: 'deploy.triggered' },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    const row = rows.find((r) => (r.metadata as { ref?: string }).ref === UNIQUE_REF);
    expect(row).toBeDefined();
    expect(row!.actorId).toBe(admin.userId);
    expect(JSON.stringify(row!.metadata)).not.toContain(TEST_TOKEN);
  });

  it('defaults the ref to main when no body is sent', async () => {
    stubDispatch(204);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/deploy',
      headers: auth(admin.token),
      payload: {},
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().ref).toBe('main');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { client_payload: { ref: string } };
    expect(body.client_payload.ref).toBe('main');
  });

  it('rejects a ref outside the git-ref-safe charset with 400', async () => {
    mockFetch.mockReset();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/deploy',
      headers: auth(admin.token),
      payload: { ref: 'main; rm -rf /' },
    });
    expect(res.statusCode).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 401 without a token', async () => {
    stubDispatch(204);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/deploy',
      payload: { ref: UNIQUE_REF },
    });
    expect(res.statusCode).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 403 for LISTENER without dispatching or auditing', async () => {
    stubDispatch(204);
    const before = await prisma.adminAuditLog.count({ where: { action: 'deploy.triggered' } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/deploy',
      headers: auth(listener.token),
      payload: { ref: UNIQUE_REF },
    });
    expect(res.statusCode).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    const after = await prisma.adminAuditLog.count({ where: { action: 'deploy.triggered' } });
    expect(after).toBe(before);
  });

  it('fails closed with 503 when the deploy token is not configured', async () => {
    const res = await appNoToken.inject({
      method: 'POST',
      url: '/v1/admin/deploy',
      headers: auth(adminNoToken.token),
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().detail).toContain('GITHUB_DEPLOY_TOKEN');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 502 when GitHub rejects the dispatch, without auditing', async () => {
    stubDispatch(401);
    const badRef = `rejected-${UNIQUE_REF}`;
    const before = await prisma.adminAuditLog.count({ where: { action: 'deploy.triggered' } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/deploy',
      headers: auth(admin.token),
      payload: { ref: badRef },
    });
    expect(res.statusCode).toBe(502);
    const after = await prisma.adminAuditLog.count({ where: { action: 'deploy.triggered' } });
    expect(after).toBe(before);
  });
});

describe('GET /v1/admin/deploy/runs', () => {
  const ghRuns = [
    {
      id: 123456,
      run_number: 42,
      name: 'CD',
      status: 'completed',
      conclusion: 'success',
      head_branch: 'main',
      event: 'repository_dispatch',
      created_at: '2026-09-26T12:00:00Z',
      updated_at: '2026-09-26T12:05:00Z',
      html_url: 'https://github.com/deepalhotra999-ux/music-streaming-platform/actions/runs/123456',
    },
  ];

  it('returns mapped workflow runs for ADMIN', async () => {
    stubRuns(ghRuns);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/deploy/runs',
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.github.com/repos/deepalhotra999-ux/music-streaming-platform/actions/runs?per_page=20',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(res.json()).toEqual({
      data: [
        {
          id: 123456,
          runNumber: 42,
          name: 'CD',
          status: 'completed',
          conclusion: 'success',
          headBranch: 'main',
          event: 'repository_dispatch',
          createdAt: '2026-09-26T12:00:00Z',
          updatedAt: '2026-09-26T12:05:00Z',
          htmlUrl: 'https://github.com/deepalhotra999-ux/music-streaming-platform/actions/runs/123456',
        },
      ],
    });
  });

  it('returns 401 without a token and 403 for LISTENER', async () => {
    const unauth = await app.inject({ method: 'GET', url: '/v1/admin/deploy/runs' });
    expect(unauth.statusCode).toBe(401);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/v1/admin/deploy/runs',
      headers: auth(listener.token),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('fails closed with 503 when the deploy token is not configured', async () => {
    const res = await appNoToken.inject({
      method: 'GET',
      url: '/v1/admin/deploy/runs',
      headers: auth(adminNoToken.token),
    });
    expect(res.statusCode).toBe(503);
  });
});
