// Phase 5 — ApiClient unit tests.
// fetch is injected, so these run without any network or React Native.

import { ApiClient, ApiError, apiErrorMessage } from '../client';

interface CapturedCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

/** Minimal Response stub: ok / status / json. */
function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeFetch(responses: Array<ReturnType<typeof jsonResponse> | Error>) {
  const calls: CapturedCall[] = [];
  const fetchFn = jest.fn(async (url: string, init: CapturedCall['init']) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('ApiClient', () => {
  it('sends JSON body with the Bearer token when one is available', async () => {
    const { fetchFn, calls } = makeFetch([jsonResponse(200, { ok: true })]);
    const client = new ApiClient({
      baseUrl: 'http://api.test/',
      fetchFn,
      getAccessToken: () => 'access-123',
    });

    await client.post<{ ok: boolean }>('/v1/me', { a: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://api.test/v1/me');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers?.Authorization).toBe('Bearer access-123');
    expect(calls[0].init.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body ?? '{}')).toEqual({ a: 1 });
  });

  it('omits Authorization when signed out, and for auth:false requests', async () => {
    const { fetchFn, calls } = makeFetch([jsonResponse(200, {}), jsonResponse(200, {})]);
    const client = new ApiClient({ baseUrl: 'http://api.test', fetchFn });

    await client.get('/v1/genres');
    await client.post('/v1/auth/login', { email: 'a@b.c', password: 'x' }, { auth: false });

    expect(calls[0].init.headers?.Authorization).toBeUndefined();
    expect(calls[1].init.headers?.Authorization).toBeUndefined();
  });

  it('parses RFC 7807 problem bodies into ApiError with field errors', async () => {
    const { fetchFn } = makeFetch([
      jsonResponse(400, {
        title: 'Validation failed',
        status: 400,
        detail: 'One or more fields are invalid.',
        errors: [{ field: 'email', message: 'Email is required.' }],
      }),
    ]);
    const client = new ApiClient({ baseUrl: 'http://api.test', fetchFn });

    const error = await client.post('/v1/auth/login', {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.title).toBe('Validation failed');
    expect(apiError.detail).toBe('One or more fields are invalid.');
    expect(apiError.fieldErrors).toEqual([{ field: 'email', message: 'Email is required.' }]);
    expect(apiErrorMessage(apiError)).toBe('One or more fields are invalid.');
  });

  it('retries once with a rotated token after a 401', async () => {
    const { fetchFn, calls } = makeFetch([
      jsonResponse(401, { title: 'Unauthorized', status: 401, detail: 'Token expired.' }),
      jsonResponse(200, { id: 'u1' }),
    ]);
    const onTokenRefresh = jest.fn(async () => 'access-new');
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetchFn,
      getAccessToken: () => 'access-old',
      onTokenRefresh,
    });

    const result = await client.get<{ id: string }>('/v1/me');

    expect(result).toEqual({ id: 'u1' });
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers?.Authorization).toBe('Bearer access-old');
    expect(calls[1].init.headers?.Authorization).toBe('Bearer access-new');
  });

  it('throws the 401 when the refresh fails instead of retrying forever', async () => {
    const { fetchFn, calls } = makeFetch([
      jsonResponse(401, { title: 'Unauthorized', status: 401, detail: 'Invalid token.' }),
    ]);
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetchFn,
      getAccessToken: () => 'access-old',
      onTokenRefresh: async () => null,
    });

    const error = await client.get('/v1/me').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).isUnauthorized).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('does not attempt refresh for unauthenticated requests', async () => {
    const { fetchFn, calls } = makeFetch([
      jsonResponse(401, { title: 'Unauthorized', status: 401 }),
    ]);
    const onTokenRefresh = jest.fn(async () => 'access-new');
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetchFn,
      getAccessToken: () => 'access-old',
      onTokenRefresh,
    });

    await expect(client.post('/v1/auth/login', {}, { auth: false })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(onTokenRefresh).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('maps network failures to ApiError with status 0', async () => {
    const { fetchFn } = makeFetch([new Error('fetch failed')]);
    const client = new ApiClient({ baseUrl: 'http://api.test', fetchFn });

    const error = await client.get('/v1/me').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(0);
    expect(apiError.isNetworkError).toBe(true);
    expect(apiErrorMessage(apiError)).toContain('Could not reach the server');
  });

  it('resolves 204 No Content as undefined', async () => {
    const { fetchFn } = makeFetch([{ ok: true, status: 204, json: async () => null }]);
    const client = new ApiClient({ baseUrl: 'http://api.test', fetchFn });

    await expect(client.post<void>('/v1/auth/logout', { refreshToken: 'r' })).resolves.toBeUndefined();
  });
});
