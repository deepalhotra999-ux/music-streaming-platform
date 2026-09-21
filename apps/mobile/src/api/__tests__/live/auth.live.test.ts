// Phase 5 — LIVE integration test against the real Phase 4 API.
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000). Exercises the exact
// ApiClient + endpoint wrappers the app ships, so a green run proves the
// mobile auth flow matches the backend contract.

import http from 'http';
import {
  ApiClient,
  ApiError,
  getApiBaseUrl,
  getMe,
  login,
  logout,
  refreshTokens,
  register,
} from '../../index';

/**
 * Minimal fetch built on Node's http module.
 * The jest-expo preset replaces global fetch with Expo's winter polyfill
 * (unusable in jest), so the live suite brings its own transport.
 */
function nodeHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers as Record<string, string> | undefined;
  if (rawHeaders) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => (data.length > 0 ? JSON.parse(data) : null),
          } as Response);
        });
      },
    );
    req.on('error', reject);
    if (init?.body) {
      req.write(init.body as string);
    }
    req.end();
  });
}

const fetchFn = nodeHttpFetch as unknown as typeof fetch;

const RUN_ID = Date.now().toString(36);
const EMAIL = `waveform-live-${RUN_ID}@example.com`;
const PASSWORD = 'LiveTest-Pass-123!';
const DISPLAY_NAME = 'Waveform Live Test';

describe('live auth flow', () => {
  const client = new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn });

  it('registers a new account (201 + token pair)', async () => {
    const result = await register(client, {
      email: EMAIL,
      password: PASSWORD,
      displayName: DISPLAY_NAME,
    });

    expect(result.user.email).toBe(EMAIL);
    expect(result.user.displayName).toBe(DISPLAY_NAME);
    expect(result.tokens.tokenType).toBe('Bearer');
    expect(result.tokens.accessToken.length).toBeGreaterThan(10);
    expect(result.tokens.refreshToken.length).toBeGreaterThan(10);
  });

  it('rejects login with the wrong password (401)', async () => {
    const error = await login(client, { email: EMAIL, password: 'Wrong-Password-1!' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });

  it('logs in, reads /v1/me, refreshes, and logs out', async () => {
    const loggedIn = await login(client, { email: EMAIL, password: PASSWORD });
    expect(loggedIn.user.email).toBe(EMAIL);

    const authed = new ApiClient({
      baseUrl: getApiBaseUrl(),
      fetchFn,
      getAccessToken: () => loggedIn.tokens.accessToken,
    });
    const me = await getMe(authed);
    expect(me.id).toBe(loggedIn.user.id);

    const rotated = await refreshTokens(client, loggedIn.tokens.refreshToken);
    // The opaque refresh token must rotate; the access JWT may be byte-
    // identical when issued within the same second (same claims).
    expect(rotated.tokens.refreshToken).not.toBe(loggedIn.tokens.refreshToken);
    expect(rotated.tokens.accessToken.length).toBeGreaterThan(10);

    await logout(client, rotated.tokens.refreshToken);

    // The logged-out refresh token is revoked.
    const reuse = await refreshTokens(client, rotated.tokens.refreshToken).catch(
      (e: unknown) => e,
    );
    expect(reuse).toBeInstanceOf(ApiError);
    expect((reuse as ApiError).status).toBe(401);
  });
});
