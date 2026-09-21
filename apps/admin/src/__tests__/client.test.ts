// Phase 16 — ApiClient tests: auth injection, 401→refresh→retry,
// problem+json mapping, and network failures.

import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../api/client';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(
  fetchFn: ReturnType<typeof vi.fn>,
  onTokenRefresh?: () => Promise<string | null>,
) {
  return new ApiClient({
    baseUrl: 'http://api.test',
    fetchFn: fetchFn as unknown as typeof fetch,
    getAccessToken: () => 'access-token',
    onTokenRefresh,
  });
}

describe('ApiClient', () => {
  it('injects the Bearer token from the getter', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, 200));
    const client = makeClient(fetchFn);

    await client.get<{ ok: boolean }>('/v1/me');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer access-token');
  });

  it('sends no Authorization header for unauthenticated requests', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, 200));
    const client = makeClient(fetchFn);

    await client.post('/v1/auth/login', { email: 'a@b.c', password: 'x' }, { auth: false });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('omits Content-Type on bodyless requests (Fastify 400s empty JSON bodies)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = makeClient(fetchFn);

    await client.delete('/v1/artists/some-id');

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('sends Content-Type: application/json when a body is present', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, 200));
    const client = makeClient(fetchFn);

    await client.patch('/v1/artists/some-id', { verified: true });

    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ verified: true }));
  });

  it('retries once with a refreshed token after a 401', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ title: 'Unauthorized', status: 401 }, 401))
      .mockResolvedValueOnce(jsonResponse({ id: 'u1' }, 200));
    const onTokenRefresh = vi.fn().mockResolvedValue('fresh-token');
    const client = makeClient(fetchFn, onTokenRefresh);

    const result = await client.get<{ id: string }>('/v1/me');

    expect(result).toEqual({ id: 'u1' });
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchFn.mock.calls[1] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer fresh-token',
    );
  });

  it('does not retry a second time when the retried request also 401s', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Unauthorized' }, 401));
    const onTokenRefresh = vi.fn().mockResolvedValue('fresh-token');
    const client = makeClient(fetchFn, onTokenRefresh);

    await expect(client.get('/v1/me')).rejects.toMatchObject({ status: 401 });
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws the 401 when refresh is unavailable', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ title: 'Unauthorized' }, 401));
    const client = makeClient(fetchFn, async () => null);

    const error = await client.get('/v1/me').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('maps RFC 7807 problem bodies onto ApiError', async () => {
    const problem = {
      type: 'https://api.example.com/problems/validation',
      title: 'Validation failed',
      status: 400,
      detail: 'role is invalid',
      errors: [{ field: 'role', message: 'must be a known role' }],
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(problem, 400));
    const client = makeClient(fetchFn);

    const error = (await client
      .patch('/v1/users/u1/role', { role: 'NOPE' })
      .catch((err: unknown) => err)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.title).toBe('Validation failed');
    expect(error.detail).toBe('role is invalid');
    expect(error.fieldErrors).toEqual([{ field: 'role', message: 'must be a known role' }]);
    expect(error.message).toBe('role is invalid');
  });

  it('surfaces network failures as status 0', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = makeClient(fetchFn);

    const error = (await client.get('/v1/me').catch((err: unknown) => err)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.isNetworkError).toBe(true);
  });
});
