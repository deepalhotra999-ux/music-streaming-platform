// Phase 13 — LIVE integration test: the full artist-management journey
// against the real Phase 4 API.
//
// ARTIST access, LISTENER denial, ownership isolation, profile/album/
// track CRUD, validation failures, cross-artist 403s, and unchanged
// public catalog behavior. ADMIN coverage lives in the backend suite
// (services/api/tests/phase4.test.ts: "owner updates their artist;
// others get 403; admin can verify").
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000, and the dev
// database). Throwaway users are registered per run; the script
// services/api/scripts/set-user-role.mjs promotes two of them to ARTIST
// (role changes are admin-only through the API by design). Everything
// created is cleaned up in afterAll.

import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';
import http from 'http';
import {
  ApiClient,
  ApiError,
  createAlbum,
  createArtist,
  createTrack,
  deleteAlbum,
  deleteArtist,
  deleteTrack,
  getApiBaseUrl,
  listArtists,
  listMyArtists,
  login,
  register,
  updateAlbum,
  updateArtistProfile,
  updateTrack,
} from '../../index';

const execFileAsync = promisify(execFile);

function nodeHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers as Record<string, string> | undefined;
  if (rawHeaders) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key] = value;
    }
  }
  return new Promise((resolvePromise, reject) => {
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
          resolvePromise({
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

const API_DIR = resolve(__dirname, '../../../../../../services/api');

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = resolve(API_DIR, '.env');
  if (!existsSync(envPath)) {
    throw new Error('DATABASE_URL is not set and services/api/.env was not found');
  }
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL not found in services/api/.env');
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

/** Promote a throwaway test user; role changes are admin-only via the API. */
async function setRole(email: string, role: 'LISTENER' | 'ARTIST'): Promise<void> {
  await execFileAsync(
    'node',
    [resolve(API_DIR, 'scripts/set-user-role.mjs'), email, role],
    { env: { ...process.env, DATABASE_URL: loadDatabaseUrl() } },
  );
}

function authedClient(accessToken: string): ApiClient {
  return new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn, getAccessToken: () => accessToken });
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('live artist platform', () => {
  const RUN_ID = Date.now().toString(36);
  const ARTIST_EMAIL = `waveform-artist-${RUN_ID}@example.com`;
  const LISTENER_EMAIL = `waveform-listener-${RUN_ID}@example.com`;
  const OTHER_EMAIL = `waveform-artist2-${RUN_ID}@example.com`;
  const PASSWORD = 'ArtistLive-Pass-123!';

  let artist: ApiClient;
  let listener: ApiClient;
  let other: ApiClient;
  let artistId = '';
  let otherArtistId = '';
  let albumId = '';
  let trackId = '';

  beforeAll(async () => {
    for (const [email, displayName] of [
      [ARTIST_EMAIL, 'Live Artist Test'],
      [LISTENER_EMAIL, 'Live Listener Test'],
      [OTHER_EMAIL, 'Live Other Artist Test'],
    ] as const) {
      await register(anon, { email, password: PASSWORD, displayName });
    }
    await setRole(ARTIST_EMAIL, 'ARTIST');
    await setRole(OTHER_EMAIL, 'ARTIST');

    const a = await login(anon, { email: ARTIST_EMAIL, password: PASSWORD });
    expect(a.user.role).toBe('ARTIST');
    artist = authedClient(a.tokens.accessToken);

    const b = await login(anon, { email: LISTENER_EMAIL, password: PASSWORD });
    expect(b.user.role).toBe('LISTENER');
    listener = authedClient(b.tokens.accessToken);

    const c = await login(anon, { email: OTHER_EMAIL, password: PASSWORD });
    other = authedClient(c.tokens.accessToken);
  });

  it('ARTIST creates their artist identity; LISTENER is denied', async () => {
    const created = await createArtist(artist, { name: `Live Artist ${RUN_ID}` });
    artistId = created.id;
    expect(created.name).toBe(`Live Artist ${RUN_ID}`);

    const mine = await listMyArtists(artist);
    expect(mine.data.some((a) => a.id === artistId)).toBe(true);

    await expectStatus(createArtist(listener, { name: 'Should Fail' }), 403);
  });

  it('artist updates their profile; others are denied', async () => {
    const profile = await updateArtistProfile(artist, artistId, {
      bio: `Live bio ${RUN_ID}`,
      website: 'https://example.com/live-artist',
    });
    expect(profile.bio).toBe(`Live bio ${RUN_ID}`);

    await expectStatus(updateArtistProfile(listener, artistId, { bio: 'hijack' }), 403);
  });

  it('album CRUD with validation failures', async () => {
    const created = await createAlbum(artist, {
      title: `Live Album ${RUN_ID}`,
      artistId,
      albumType: 'EP',
    });
    albumId = created.id;
    expect(created.albumType).toBe('EP');

    const updated = await updateAlbum(artist, albumId, {
      title: `Live Album ${RUN_ID} Deluxe`,
    });
    expect(updated.title).toBe(`Live Album ${RUN_ID} Deluxe`);

    // Validation: empty title is rejected.
    await expectStatus(createAlbum(artist, { title: '', artistId }), 400);
    // A listener cannot touch artist content.
    await expectStatus(updateAlbum(listener, albumId, { title: 'hijack' }), 403);
  });

  it('track CRUD; manual READY is rejected (pipeline owns readiness)', async () => {
    const created = await createTrack(artist, {
      title: `Live Track ${RUN_ID}`,
      artistId,
      albumId,
      durationMs: 120_000,
    });
    trackId = created.id;
    // New tracks start as PROCESSING (draft).
    expect(created.status).toBe('PROCESSING');

    // Phase 14 — clients cannot claim READY by hand on create or update;
    // only the audio pipeline promotes a track once its HLS validates.
    await expectStatus(updateTrack(artist, trackId, { status: 'READY' }), 422);
    await expectStatus(
      createTrack(artist, {
        title: `Live Track READY ${RUN_ID}`,
        artistId,
        durationMs: 60_000,
        status: 'READY',
      }),
      422,
    );

    // Other manual transitions still work (takedown flow), then restore.
    const takenDown = await updateTrack(artist, trackId, { status: 'TAKEDOWN' });
    expect(takenDown.status).toBe('TAKEDOWN');
    const restored = await updateTrack(artist, trackId, { status: 'PROCESSING' });
    expect(restored.status).toBe('PROCESSING');

    // Duplicate ISRC is rejected.
    await updateTrack(artist, trackId, { isrc: `LIVE-${RUN_ID}` });
    await expectStatus(
      createTrack(artist, {
        title: `Live Track 2 ${RUN_ID}`,
        artistId,
        durationMs: 60_000,
        isrc: `LIVE-${RUN_ID}`,
      }),
      409,
    );
    // A listener cannot create tracks for someone else's artist.
    await expectStatus(
      createTrack(listener, { title: 'hijack', artistId, durationMs: 60_000 }),
      403,
    );
  });

  it('cross-artist writes are rejected', async () => {
    const created = await createArtist(other, { name: `Other Artist ${RUN_ID}` });
    otherArtistId = created.id;

    await expectStatus(updateAlbum(other, albumId, { title: 'steal' }), 403);
    await expectStatus(deleteTrack(other, trackId), 403);
    await expectStatus(updateArtistProfile(other, artistId, { bio: 'steal' }), 403);
  });

  it('public catalog still serves the new artist content anonymously', async () => {
    const found = await listArtists(anon, { q: `Live Artist ${RUN_ID}` });
    expect(found.data.some((a) => a.id === artistId)).toBe(true);
  });

  afterAll(async () => {
    // Reverse order of the 409 guards: tracks → albums → artists.
    if (trackId) await deleteTrack(artist, trackId).catch(() => {});
    if (albumId) await deleteAlbum(artist, albumId).catch(() => {});
    if (artistId) await deleteArtist(artist, artistId).catch(() => {});
    if (otherArtistId) await deleteArtist(other, otherArtistId).catch(() => {});
  });
});
