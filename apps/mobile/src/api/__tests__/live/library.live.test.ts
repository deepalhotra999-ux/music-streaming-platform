// Phase 11 — LIVE integration test: the full Library → Playlist → Play
// journey against the real Phase 4/7 API.
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000). A throwaway user is
// registered per run; everything created (likes, follows, playlist) is
// cleaned up in afterAll.

import http from 'http';
import {
  ApiClient,
  ApiError,
  addTrackToPlaylist,
  createPlaybackSession,
  createPlaylist,
  deletePlaylist,
  followArtist,
  getApiBaseUrl,
  getPlaylist,
  likeTrack,
  listFollowedArtists,
  listHistory,
  listLikedTracks,
  listMyPlaylists,
  listTracks,
  login,
  movePlaylistItem,
  register,
  removePlaylistItem,
  unfollowArtist,
  unlikeTrack,
  updatePlaylist,
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
const anon = new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn });

describe('live library → playlist → play', () => {
  const RUN_ID = Date.now().toString(36);
  const EMAIL = `waveform-library-${RUN_ID}@example.com`;
  const PASSWORD = 'LibraryLive-Pass-123!';
  let authed: ApiClient;
  let trackId = '';
  let artistId = '';
  let playlistId = '';

  beforeAll(async () => {
    const registered = await register(anon, {
      email: EMAIL,
      password: PASSWORD,
      displayName: 'Library Live Test',
    });
    authed = new ApiClient({
      baseUrl: getApiBaseUrl(),
      fetchFn,
      getAccessToken: () => registered.tokens.accessToken,
    });
    const tracks = await listTracks(anon, { limit: 2 });
    expect(tracks.data.length).toBeGreaterThan(0);
    trackId = tracks.data[0].id;
    artistId = tracks.data[0].artistId;
  });

  it('likes and unlikes a track', async () => {
    await likeTrack(authed, trackId);
    const liked = await listLikedTracks(authed, { limit: 20 });
    expect(liked.data.some((item) => item.trackId === trackId)).toBe(true);

    await unlikeTrack(authed, trackId);
    const after = await listLikedTracks(authed, { limit: 20 });
    expect(after.data.some((item) => item.trackId === trackId)).toBe(false);
  });

  it('follows and unfollows an artist', async () => {
    await followArtist(authed, artistId);
    const followed = await listFollowedArtists(authed, { limit: 20 });
    expect(followed.data.some((item) => item.artistId === artistId)).toBe(true);

    await unfollowArtist(authed, artistId);
    const after = await listFollowedArtists(authed, { limit: 20 });
    expect(after.data.some((item) => item.artistId === artistId)).toBe(false);
  });

  it('creates a playlist, adds tracks, reorders, and removes', async () => {
    const created = await createPlaylist(authed, {
      title: `Live Library Playlist ${RUN_ID}`,
      visibility: 'PRIVATE',
    });
    playlistId = created.id;
    expect(created.visibility).toBe('PRIVATE');

    const mine = await listMyPlaylists(authed, { limit: 20 });
    expect(mine.data.some((p) => p.id === playlistId)).toBe(true);

    const tracks = await listTracks(anon, { limit: 2 });
    const [first, second] = tracks.data;
    await addTrackToPlaylist(authed, playlistId, { trackId: first.id });
    await addTrackToPlaylist(authed, playlistId, { trackId: second.id });

    let detail = await getPlaylist(authed, playlistId);
    expect(detail.items.map((item) => item.track.id)).toEqual([first.id, second.id]);

    // Move the second track above the first by swapping positions.
    const [itemA, itemB] = detail.items;
    await movePlaylistItem(authed, playlistId, itemB.id, itemA.position);
    await movePlaylistItem(authed, playlistId, itemA.id, itemB.position);
    detail = await getPlaylist(authed, playlistId);
    expect(detail.items.map((item) => item.track.id)).toEqual([second.id, first.id]);

    // Remove the (now first) track.
    await removePlaylistItem(authed, playlistId, detail.items[0].id);
    detail = await getPlaylist(authed, playlistId);
    expect(detail.items.map((item) => item.track.id)).toEqual([first.id]);
  });

  it('renames the playlist', async () => {
    const updated = await updatePlaylist(authed, playlistId, {
      title: `Renamed Live Playlist ${RUN_ID}`,
    });
    expect(updated.title).toBe(`Renamed Live Playlist ${RUN_ID}`);
  });

  it('hides the private playlist from anonymous readers', async () => {
    const error = await getPlaylist(anon, playlistId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('creates a playback session for a playlist track (play integration)', async () => {
    const session = await createPlaybackSession(authed, trackId);
    expect(session.hlsUrl.length).toBeGreaterThan(0);
    expect(session.expiresAt.length).toBeGreaterThan(0);
  });

  it('paginates the liked list and reads history', async () => {
    await likeTrack(authed, trackId);
    const firstPage = await listLikedTracks(authed, { limit: 1 });
    expect(firstPage.pagination.page).toBe(1);
    expect(firstPage.pagination.limit).toBe(1);
    if (firstPage.pagination.totalPages > 1) {
      const secondPage = await listLikedTracks(authed, { page: 2, limit: 1 });
      expect(secondPage.pagination.page).toBe(2);
    }
    const history = await listHistory(authed, { limit: 5 });
    expect(history.pagination).toBeDefined();
    await unlikeTrack(authed, trackId);
  });

  afterAll(async () => {
    // Clean up everything this suite created.
    const relogin = await login(anon, { email: EMAIL, password: PASSWORD });
    const cleanup = new ApiClient({
      baseUrl: getApiBaseUrl(),
      fetchFn,
      getAccessToken: () => relogin.tokens.accessToken,
    });
    await unlikeTrack(cleanup, trackId).catch(() => {});
    await unfollowArtist(cleanup, artistId).catch(() => {});
    if (playlistId) {
      await deletePlaylist(cleanup, playlistId);
      const gone = await getPlaylist(anon, playlistId).catch((e: unknown) => e);
      expect(gone).toBeInstanceOf(ApiError);
      expect((gone as ApiError).status).toBe(404);
    }
  });
});
