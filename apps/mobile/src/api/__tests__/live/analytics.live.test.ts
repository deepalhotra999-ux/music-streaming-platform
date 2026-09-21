// Phase 15 — LIVE integration test: artist analytics against the real API.
//
// A throwaway ARTIST (promoted via services/api/scripts/set-user-role.mjs)
// creates an artist + track; a throwaway LISTENER drives one real playback
// session (START → HEARTBEAT → COMPLETE via the Phase 7 streaming
// endpoints); then the Phase 15 analytics endpoints must aggregate exactly
// that play. Covers overview totals, per-track stats, trend buckets,
// recent activity, LISTENER denial, and cross-artist isolation. Everything
// created is cleaned up in afterAll (track/artist soft-deletes; the
// session rows reference a soft-deleted track and stay out of future
// analytics scopes).
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000, and the dev
// database).

import { execFile } from 'child_process';
import { cpSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { promisify } from 'util';
import http from 'http';
import {
  ApiClient,
  ApiError,
  createArtist,
  createPlaybackSession,
  createTrack,
  deleteArtist,
  deleteTrack,
  getApiBaseUrl,
  getArtistAlbumStats,
  getArtistOverview,
  getArtistRecentActivity,
  getArtistTrackStats,
  getArtistTrend,
  login,
  register,
  reportPlayEvent,
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
  // The .env value may be wrapped in double quotes; strip them.
  return line.slice('DATABASE_URL='.length).replace(/^"|"$/g, '');
}

/** Promote a throwaway test user; role changes are admin-only via the API. */
async function setRole(email: string, role: 'LISTENER' | 'ARTIST'): Promise<void> {
  await execFileAsync('node', [resolve(API_DIR, 'scripts/set-user-role.mjs'), email, role], {
    env: { ...process.env, DATABASE_URL: loadDatabaseUrl() },
  });
}

function authedClient(accessToken: string): ApiClient {
  return new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn, getAccessToken: () => accessToken });
}

/**
 * Make a throwaway track streamable in the dev DB. New tracks are created
 * PROCESSING (Phase 14 ingestion pipeline) with no audio package, and
 * createPlaybackSession requires both READY status and the HLS master
 * playlist on disk. Driving the real ffmpeg pipeline here would couple
 * this analytics test to audio processing, so the setup mirrors the
 * pipeline's post-processing state instead: flip the status and stage a
 * copy of an existing seeded track's dev HLS package under this track's
 * storage key. Test setup only; the play events themselves are real.
 */
async function prepareStreamableTrack(trackId: string): Promise<void> {
  const storageDir = join(API_DIR, 'storage', 'audio', 'tracks');
  const entries = readdirSync(storageDir).filter((e) => e !== trackId);
  if (entries.length === 0) {
    throw new Error('no seeded track audio found to stage from');
  }
  const dest = join(storageDir, trackId, 'hls');
  if (!existsSync(dest)) {
    cpSync(join(storageDir, entries[0], 'hls'), dest, { recursive: true });
  }

  const script = `
    const { PrismaClient } = await import('/home/hatch/workspace/node_modules/@prisma/client/index.js');
    const prisma = new PrismaClient();
    try {
      await prisma.track.update({
        where: { id: process.env.LIVE_TRACK_ID },
        data: { status: 'READY' },
      });
    } finally {
      await prisma.$disconnect();
    }
  `;
  await execFileAsync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, DATABASE_URL: loadDatabaseUrl(), LIVE_TRACK_ID: trackId },
  });
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('live artist analytics', () => {
  const RUN_ID = Date.now().toString(36);
  const ARTIST_EMAIL = `waveform-analytics-artist-${RUN_ID}@example.com`;
  const LISTENER_EMAIL = `waveform-analytics-listener-${RUN_ID}@example.com`;
  const PASSWORD = 'AnalyticsLive-Pass-123!';

  let artist: ApiClient;
  let listener: ApiClient;
  let artistId = '';
  let trackId = '';

  beforeAll(async () => {
    for (const [email, displayName] of [
      [ARTIST_EMAIL, 'Live Analytics Artist'],
      [LISTENER_EMAIL, 'Live Analytics Listener'],
    ] as const) {
      await register(anon, { email, password: PASSWORD, displayName });
    }
    await setRole(ARTIST_EMAIL, 'ARTIST');

    const a = await login(anon, { email: ARTIST_EMAIL, password: PASSWORD });
    expect(a.user.role).toBe('ARTIST');
    artist = authedClient(a.tokens.accessToken);

    const b = await login(anon, { email: LISTENER_EMAIL, password: PASSWORD });
    listener = authedClient(b.tokens.accessToken);

    const created = await createArtist(artist, { name: `Live Analytics ${RUN_ID}` });
    artistId = created.id;
    const track = await createTrack(artist, {
      title: `Live Analytics Track ${RUN_ID}`,
      artistId,
      durationMs: 180_000,
    });
    trackId = track.id;
    await prepareStreamableTrack(trackId);

    // One genuine completed play by the listener.
    const session = await createPlaybackSession(listener, trackId);
    await reportPlayEvent(listener, session.id, 'START', 0);
    await reportPlayEvent(listener, session.id, 'HEARTBEAT', 30_000);
    await reportPlayEvent(listener, session.id, 'COMPLETE', 60_000);
  }, 120_000);

  afterAll(async () => {
    if (trackId) await deleteTrack(artist, trackId).catch(() => {});
    if (artistId) await deleteArtist(artist, artistId).catch(() => {});
  });

  it('aggregates the completed play in the overview', async () => {
    const overview = await getArtistOverview(artist, artistId, { range: 'all' });
    expect(overview.artistId).toBe(artistId);
    expect(overview.streams).toBe(1);
    expect(overview.starts).toBe(1);
    expect(overview.failedPlays).toBe(0);
    expect(overview.uniqueListeners).toBe(1);
    // START@0 → HB@30000 → COMPLETE@60000 = 60s of listening time.
    expect(overview.listeningTimeMs).toBe(60_000);
  });

  it('attributes the play to the track', async () => {
    const page = await getArtistTrackStats(artist, artistId, { range: 'all' });
    expect(page.data).toHaveLength(1);
    expect(page.data[0].trackId).toBe(trackId);
    expect(page.data[0].streams).toBe(1);
  });

  it('buckets the play in the trend', async () => {
    const trend = await getArtistTrend(artist, artistId, { range: '7d', granularity: 'day' });
    const total = trend.points.reduce((n, p) => n + p.streams, 0);
    expect(total).toBe(1);
  });

  it('lists the play in recent activity without listener identity', async () => {
    const { data } = await getArtistRecentActivity(artist, artistId, { range: 'all' });
    expect(data).toHaveLength(1);
    expect(data[0].trackId).toBe(trackId);
    expect(data[0].trackTitle).toContain('Live Analytics Track');
    expect(data[0]).not.toHaveProperty('userId');
  });

  it('denies LISTENER analytics access and isolates artists', async () => {
    await expectStatus(getArtistOverview(listener, artistId, { range: 'all' }), 403);
    await expectStatus(getArtistTrackStats(listener, artistId, { range: 'all' }), 403);
    await expectStatus(getArtistAlbumStats(listener, artistId, { range: 'all' }), 403);
    await expectStatus(getArtistTrend(listener, artistId, { range: 'all' }), 403);
    await expectStatus(getArtistRecentActivity(listener, artistId, { range: 'all' }), 403);

    // A fresh artist with no plays sees zeros, not the other artist's data.
    const other = await createArtist(artist, { name: `Live Analytics Other ${RUN_ID}` });
    try {
      const overview = await getArtistOverview(artist, other.id, { range: 'all' });
      expect(overview.streams).toBe(0);
      expect(overview.starts).toBe(0);
    } finally {
      await deleteArtist(artist, other.id).catch(() => {});
    }
  });
});
