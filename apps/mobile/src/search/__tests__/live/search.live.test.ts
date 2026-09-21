// Phase 12 — LIVE search test: searchCatalog against the real Phase 4 API
// with seeded catalog data, plus the playlist privacy boundary.
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000). Uses the same
// nodeHttpFetch transport as the other live suites.

import http from 'http';
import {
  ApiClient,
  createPlaylist,
  deletePlaylist,
  getApiBaseUrl,
  register,
} from '../../../api';
import { searchCatalog } from '../../api';

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
const anon = new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn });

describe('live search across the catalog (no token)', () => {
  it('finds the seeded artist by name', async () => {
    const results = await searchCatalog(anon, 'neon');
    expect(results.artists.items.some((a) => a.name === 'Neon Coastline')).toBe(true);
    expect(results.artists.total).toBeGreaterThan(0);
  });

  it('finds the seeded album by title', async () => {
    const results = await searchCatalog(anon, 'glass');
    expect(results.albums.items.some((a) => a.title === 'Glass Horizon')).toBe(true);
  });

  it('finds the seeded track by title', async () => {
    const results = await searchCatalog(anon, 'copper');
    expect(results.tracks.items.some((t) => t.title === 'Copper Skyline')).toBe(true);
  });

  it('finds the seeded genre by name', async () => {
    const results = await searchCatalog(anon, 'electronic');
    expect(results.genres.items.some((g) => g.name === 'Electronic')).toBe(true);
  });

  it('is case-insensitive', async () => {
    const lower = await searchCatalog(anon, 'neon');
    const upper = await searchCatalog(anon, 'NEON');
    expect(upper.artists.total).toBe(lower.artists.total);
    expect(upper.artists.total).toBeGreaterThan(0);
  });

  it('returns empty categories for a nonsense query', async () => {
    const results = await searchCatalog(anon, 'zzz-no-such-thing-anywhere');
    expect(results.artists.total).toBe(0);
    expect(results.albums.total).toBe(0);
    expect(results.tracks.total).toBe(0);
    expect(results.genres.total).toBe(0);
    expect(results.playlists.total).toBe(0);
  });

  it('never surfaces the seeded PRIVATE playlist in anonymous search', async () => {
    const results = await searchCatalog(anon, 'focus mix');
    expect(results.playlists.items.some((p) => p.title === "Mia's Focus Mix")).toBe(false);
  });
});

describe('live search playlist privacy (authenticated owner)', () => {
  const RUN_ID = Date.now().toString(36);
  const EMAIL = `waveform-search-${RUN_ID}@example.com`;
  const PASSWORD = 'SearchLive-Pass-123!';
  const privateTitle = `Live Search Private ${RUN_ID}`;
  const publicTitle = `Live Search Public ${RUN_ID}`;
  let authed: ApiClient;
  const playlistIds: string[] = [];

  beforeAll(async () => {
    const registered = await register(anon, {
      email: EMAIL,
      password: PASSWORD,
      displayName: 'Search Live Test',
    });
    authed = new ApiClient({
      baseUrl: getApiBaseUrl(),
      fetchFn,
      getAccessToken: () => registered.tokens.accessToken,
    });
  });

  afterAll(async () => {
    for (const id of playlistIds) {
      await deletePlaylist(authed, id).catch(() => {});
    }
  });

  it('hides a PRIVATE playlist from anonymous search but shows a PUBLIC one', async () => {
    const createdPrivate = await createPlaylist(authed, {
      title: privateTitle,
      visibility: 'PRIVATE',
    });
    playlistIds.push(createdPrivate.id);
    const createdPublic = await createPlaylist(authed, {
      title: publicTitle,
      visibility: 'PUBLIC',
    });
    playlistIds.push(createdPublic.id);

    // `contains` is substring matching, so search the contiguous run id.
    const results = await searchCatalog(anon, RUN_ID);
    const titles = results.playlists.items.map((p) => p.title);
    expect(titles).toContain(publicTitle);
    expect(titles).not.toContain(privateTitle);
  });
});
