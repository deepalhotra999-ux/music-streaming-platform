// Phase 6 — LIVE integration test for the catalog wrappers against the real
// Phase 4 API.
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000). Uses the same
// nodeHttpFetch transport as the auth live suite.

import http from 'http';
import {
  ApiClient,
  ApiError,
  getAlbum,
  getApiBaseUrl,
  getArtist,
  getGenre,
  getPlaylist,
  listAlbums,
  listArtists,
  listGenres,
  listPublicPlaylists,
  listTracks,
  login,
  register,
  type PlaylistDetail,
} from '../../index';

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

// Anonymous client: no access-token provider, so no Authorization header.
const anon = new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn });

describe('live public catalog (no token)', () => {
  it('lists artists with pagination envelope', async () => {
    const page = await listArtists(anon, { limit: 1 });
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.pagination.page).toBe(1);
    expect(page.pagination.total).toBeGreaterThan(0);
    expect(page.data[0].name.length).toBeGreaterThan(0);
  });

  it('reads an artist detail with profile and counts', async () => {
    const first = await listArtists(anon, { limit: 1 });
    const artist = await getArtist(anon, first.data[0].id);
    expect(artist.name).toBe(first.data[0].name);
    expect(artist.counts.albums).toBeGreaterThan(0);
    expect(artist.counts.tracks).toBeGreaterThan(0);
  });

  it('lists albums and reads an album detail with embedded tracks', async () => {
    const page = await listAlbums(anon, { limit: 5 });
    expect(page.data.length).toBeGreaterThan(0);
    const album = await getAlbum(anon, page.data[0].id);
    expect(album.title).toBe(page.data[0].title);
    expect(album.tracks.length).toBeGreaterThan(0);
    expect(album.tracks[0].title.length).toBeGreaterThan(0);
  });

  it('paginates tracks and filters by artist', async () => {
    const all = await listTracks(anon, { limit: 2 });
    expect(all.data.length).toBeLessThanOrEqual(2);
    if (all.pagination.totalPages > 1) {
      const second = await listTracks(anon, { page: 2, limit: 2 });
      expect(second.pagination.page).toBe(2);
      expect(second.data[0].id).not.toBe(all.data[0].id);
    }
    const artistId = all.data[0].artistId;
    const filtered = await listTracks(anon, { artistId, limit: 20 });
    expect(filtered.data.length).toBeGreaterThan(0);
    for (const track of filtered.data) {
      expect(track.artistId).toBe(artistId);
    }
  });

  it('lists genres and reads a genre detail', async () => {
    const page = await listGenres(anon, { limit: 20 });
    expect(page.data.length).toBeGreaterThan(0);
    const genre = await getGenre(anon, page.data[0].id);
    expect(genre.name).toBe(page.data[0].name);
    expect(genre.trackCount).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 for an unknown artist id', async () => {
    const error = await getArtist(anon, '00000000-0000-0000-0000-000000000000').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });
});

describe('live public playlist browsing', () => {
  const RUN_ID = Date.now().toString(36);
  const EMAIL = `waveform-catalog-${RUN_ID}@example.com`;
  const PASSWORD = 'CatalogLive-Pass-123!';
  let playlistId = '';

  it('creates a public playlist with tracks as an authenticated user', async () => {
    const registered = await register(anon, {
      email: EMAIL,
      password: PASSWORD,
      displayName: 'Catalog Live Test',
    });
    const authed = new ApiClient({
      baseUrl: getApiBaseUrl(),
      fetchFn,
      getAccessToken: () => registered.tokens.accessToken,
    });

    const created = await authed.post<PlaylistDetail>('/v1/playlists', {
      title: `Live Test Playlist ${RUN_ID}`,
      visibility: 'PUBLIC',
    });
    playlistId = created.id;
    expect(created.visibility).toBe('PUBLIC');

    const tracks = await listTracks(anon, { limit: 2 });
    expect(tracks.data.length).toBeGreaterThan(0);
    for (const track of tracks.data) {
      await authed.post(`/v1/playlists/${playlistId}/tracks`, { trackId: track.id });
    }

    const detail = await getPlaylist(anon, playlistId);
    expect(detail.items.length).toBe(tracks.data.length);
    expect(detail.items[0].track.title.length).toBeGreaterThan(0);

    // The public browse endpoint surfaces it without a token.
    const browse = await listPublicPlaylists(anon, { limit: 20 });
    expect(browse.data.some((p) => p.id === playlistId)).toBe(true);

    await login(anon, { email: EMAIL, password: PASSWORD });
  });

  afterAll(async () => {
    if (playlistId) {
      const relogin = await login(anon, { email: EMAIL, password: PASSWORD });
      const authed = new ApiClient({
        baseUrl: getApiBaseUrl(),
        fetchFn,
        getAccessToken: () => relogin.tokens.accessToken,
      });
      await authed.delete(`/v1/playlists/${playlistId}`);
      const gone = await getPlaylist(anon, playlistId).catch((e: unknown) => e);
      expect(gone).toBeInstanceOf(ApiError);
      expect((gone as ApiError).status).toBe(404);
    }
  });
});
