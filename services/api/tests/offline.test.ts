/**
 * Phase 25 — offline downloads & offline playback tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB), plus service-level re-ingestion tests with real ffmpeg/ffprobe.
 *
 * Covers:
 * - Download authorization: entitlement gating, track availability, the
 *   once-only delivery token, idempotent re-authorization (same grant id,
 *   rotated token, window NOT extended), and error shapes (401/400/403/
 *   404/409).
 * - HLS delivery: token-scoped master/rendition/segment routes, URI
 *   rewriting, Range/416, token expiry, indistinguishability of
 *   invalid/expired/revoked tokens (all 401), and no permanent URLs.
 * - Revalidation: sliding window while entitled; CANCELED keeps the
 *   existing window without extension; PAST_DUE/EXPIRED/REVOKED/no-sub
 *   revoke the grant; TAKEDOWN/deletion revokes; audio-version mismatch
 *   flags staleness; owner scoping (404 for other users' ids).
 * - Offline event sync: idempotency per event key, authorization-window
 *   validation, ownership checks, strict per-session sequence validation
 *   (single START/COMPLETE, monotonic positions/timestamps, duration
 *   bounds), and appends to play_events attached to synthetic server-side
 *   playback sessions per offlineSessionKey (tokenHash null) so offline
 *   plays join session aggregates exactly like online plays.
 * - Re-ingestion bumps Track.audioVersion exactly once per replacement
 *   of published audio.
 *
 * Cleanup is scoped to `@offline-test.local` addresses plus the temp
 * audio/fixtures dirs. ffmpeg/ffprobe must be on PATH.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';
import type { AuthUser } from '../src/http/auth.js';
import {
  processTrackAudio,
  uploadTrackAudio,
  type IngestionDeps,
} from '../src/modules/ingestion/service.js';
import { LocalFileStorage } from '../src/modules/streaming/storage.js';

const execFileAsync = promisify(execFile);

const TEST_DOMAIN = '@offline-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase25-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;
let audioDir: string;
let fixturesDir: string;
let ingestionDeps: IngestionDeps;

interface TestUser {
  id: string;
  email: string;
  token: string;
}

async function createUser(
  tag: string,
  role: 'LISTENER' | 'ARTIST' = 'LISTENER',
): Promise<TestUser> {
  const email = testEmail(tag);
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: `${tag} User` },
  });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().user.id as string;
  if (role !== 'LISTENER') {
    await prisma.user.update({ where: { id: userId }, data: { role } });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return { id: userId, email, token: login.json().tokens.accessToken as string };
}

const auth = (user: TestUser) => ({ authorization: `Bearer ${user.token}` });

/** FK-safe cleanup, children before parents. */
async function scopedClean(): Promise<void> {
  const userWhere = { user: { email: { endsWith: TEST_DOMAIN } } };
  await prisma.playEvent.deleteMany({ where: userWhere });
  await prisma.offlineDownloadAuthorization.deleteMany({ where: userWhere });
  await prisma.playbackSession.deleteMany({ where: userWhere });
  // subscription_events is append-only (Phase 18 trigger rejects DELETE).
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "subscription_events" DISABLE TRIGGER "subscription_events_no_delete"',
  );
  await prisma.subscriptionEvent.deleteMany({ where: { subscription: userWhere } });
  await prisma.subscription.deleteMany({ where: userWhere });
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "subscription_events" ENABLE TRIGGER "subscription_events_no_delete"',
  );
  await prisma.track.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.refreshToken.deleteMany({ where: userWhere });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
}

// --- Dev subscription events (Phase 18 deterministic adapter) ----------------

async function devEvent(user: TestUser, body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/dev/subscription-events',
    headers: auth(user),
    payload: body,
  });
  return { status: res.statusCode, body: res.json() };
}

async function grantActive(user: TestUser, ext: string): Promise<void> {
  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const end = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const r = await devEvent(user, {
    providerEventId: `${ext}-start`,
    eventType: 'SUBSCRIPTION_STARTED',
    externalSubscriptionId: ext,
    planCode: 'premium_individual',
    periodStart: start,
    periodEnd: end,
  });
  expect(r.status).toBe(201);
  expect(r.body.entitlement.entitled).toBe(true);
}

// --- HLS fixture --------------------------------------------------------------

const SEG0 = Buffer.from('0123456789ABCDEF'.repeat(64), 'utf8'); // 1024 bytes
const SEG1 = Buffer.from('abcdef'.repeat(85) + 'ab', 'utf8'); // 512 bytes

async function writeHlsPackage(trackId: string): Promise<void> {
  const base = path.join(audioDir, 'tracks', trackId, 'hls');
  const rendition = path.join(base, '128k');
  await fs.mkdir(rendition, { recursive: true });
  await fs.writeFile(
    path.join(base, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\n128k/index.m3u8\n',
  );
  await fs.writeFile(
    path.join(rendition, 'index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXTINF:6.0,\nseg-00000.ts\n#EXTINF:6.0,\nseg-00001.ts\n#EXT-X-ENDLIST\n',
  );
  await fs.writeFile(path.join(rendition, 'seg-00000.ts'), SEG0);
  await fs.writeFile(path.join(rendition, 'seg-00001.ts'), SEG1);
}

// --- Ingestion fixtures (audioVersion bump) ------------------------------------

async function synthAudio(outPath: string, seconds: number, frequency: number): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:duration=${seconds}`,
      '-ar',
      '44100',
      '-ac',
      '2',
      outPath,
    ],
    { timeout: 120_000 },
  );
}

/** Service-level upload: copies a fixture to a temp path the service validates. */
async function serviceUpload(trackId: string, fixturePath: string, actor: AuthUser) {
  const tmp = path.join(os.tmpdir(), `phase25-${Date.now()}-${counter++}.up`);
  await fs.copyFile(fixturePath, tmp);
  try {
    const stat = await fs.stat(tmp);
    return await uploadTrackAudio(
      { trackId, actor, tmpPath: tmp, bytes: stat.size },
      ingestionDeps,
    );
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

// --- Suite fixtures ------------------------------------------------------------

let entitled: TestUser;
let free: TestUser;
let other: TestUser;
let artistOwner: TestUser;
let artistId: string;
let readyTrackId: string;
let noAssetsTrackId: string;
let processingTrackId: string;
let takedownTrackId: string;

interface AuthorizeResult {
  authorizationId: string;
  token: string;
  downloadTokenExpiresAt: string;
  expiresAt: string;
  audioVersion: number;
  track: {
    id: string;
    title: string;
    artistName: string;
    albumTitle: string | null;
    durationMs: number;
  };
  downloadUrl: string;
}

async function authorize(user: TestUser, trackId: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/offline/downloads/authorize',
    headers: auth(user),
    payload: { trackId },
  });
}

beforeAll(async () => {
  audioDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase25-audio-'));
  fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase25-fixtures-'));
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    RATE_LIMIT_LOGIN: '1000',
    RATE_LIMIT_REGISTER: '1000',
    RATE_LIMIT_REFRESH: '1000',
    RATE_LIMIT_LOGOUT: '1000',
    RATE_LIMIT_API: '10000',
    RATE_LIMIT_STREAMING: '10000',
    RATE_LIMIT_OFFLINE_AUTHORIZE: '10000',
    AUDIO_STORAGE_DRIVER: 'local',
    AUDIO_STORAGE_DIR: audioDir,
    DEV_SUBSCRIPTIONS_ENABLED: 'true',
  });
  app = await buildApp(config);
  ingestionDeps = {
    db: prisma,
    storage: new LocalFileStorage(audioDir),
    config,
    log: () => {},
  };
  await scopedClean();

  entitled = await createUser('entitled');
  free = await createUser('free');
  other = await createUser('other');
  artistOwner = await createUser('artist-owner', 'ARTIST');
  await grantActive(entitled, `ext-${Date.now()}-a`);
  await grantActive(other, `ext-${Date.now()}-b`);

  const artist = await prisma.artist.create({
    data: { name: 'Phase25 Artist', ownerUserId: artistOwner.id },
    select: { id: true },
  });
  artistId = artist.id;
  const mkTrack = (title: string, status: 'READY' | 'PROCESSING' | 'TAKEDOWN') =>
    prisma.track.create({
      data: { title, artistId, durationMs: 12_000, status },
      select: { id: true },
    });
  readyTrackId = (await mkTrack('Ready Track', 'READY')).id;
  noAssetsTrackId = (await mkTrack('No Assets Track', 'READY')).id;
  processingTrackId = (await mkTrack('Processing Track', 'PROCESSING')).id;
  takedownTrackId = (await mkTrack('Takedown Track', 'TAKEDOWN')).id;
  await writeHlsPackage(readyTrackId);
}, 120_000);

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
  await fs.rm(audioDir, { recursive: true, force: true });
  await fs.rm(fixturesDir, { recursive: true, force: true });
});

// --- Authorization ----------------------------------------------------------------

describe('POST /v1/offline/downloads/authorize', () => {
  it('mints a grant with a once-only delivery token for an entitled user', async () => {
    const res = await authorize(entitled, readyTrackId);
    expect(res.statusCode).toBe(201);
    const body = res.json() as AuthorizeResult;
    expect(body.authorizationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.audioVersion).toBe(1);
    expect(body.track.id).toBe(readyTrackId);
    expect(body.track.title).toBe('Ready Track');
    expect(body.track.artistName).toBe('Phase25 Artist');
    expect(new Date(body.downloadTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The delivery URL is token-scoped, never a permanent public URL.
    expect(body.downloadUrl).toContain('/v1/offline/downloads/hls/master.m3u8?token=');
    expect(body.downloadUrl).toContain(body.token);

    // The stored record keeps only the hash, never the raw token.
    const row = await prisma.offlineDownloadAuthorization.findUniqueOrThrow({
      where: { id: body.authorizationId },
    });
    expect(row.tokenHash).not.toBe(body.token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects unauthenticated callers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/offline/downloads/authorize',
      payload: { trackId: readyTrackId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing and malformed track ids', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/offline/downloads/authorize',
      headers: auth(entitled),
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const malformed = await authorize(entitled, 'not-a-uuid');
    expect(malformed.statusCode).toBe(400);
  });

  it('returns 404 for a nonexistent track', async () => {
    const res = await authorize(entitled, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
  });

  it('denies non-READY tracks: PROCESSING and TAKEDOWN both 409', async () => {
    expect((await authorize(entitled, processingTrackId)).statusCode).toBe(409);
    expect((await authorize(entitled, takedownTrackId)).statusCode).toBe(409);
  });

  it('returns 409 when the catalog says READY but the audio package is missing', async () => {
    const res = await authorize(entitled, noAssetsTrackId);
    expect(res.statusCode).toBe(409);
  });

  it('denies listeners without an eligible subscription (403)', async () => {
    const res = await authorize(free, readyTrackId);
    expect(res.statusCode).toBe(403);
    expect(res.json().title).toMatch(/subscription/i);
  });

  it('is idempotent: re-authorize returns the same grant, rotates the token, keeps the window', async () => {
    const first = (await authorize(entitled, readyTrackId)).json() as AuthorizeResult;
    const second = (await authorize(entitled, readyTrackId)).json() as AuthorizeResult;
    expect(second.authorizationId).toBe(first.authorizationId);
    expect(second.token).not.toBe(first.token);
    // The entitlement window is NOT extended by re-authorizing.
    expect(second.expiresAt).toBe(first.expiresAt);
    // The old delivery token is dead.
    const stale = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/master.m3u8?token=${first.token}`,
    });
    expect(stale.statusCode).toBe(401);
    const fresh = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/master.m3u8?token=${second.token}`,
    });
    expect(fresh.statusCode).toBe(200);
  });
});

// --- HLS delivery ------------------------------------------------------------------

describe('token-scoped HLS delivery', () => {
  let token: string;

  beforeAll(async () => {
    const res = await authorize(entitled, readyTrackId);
    expect(res.statusCode).toBe(201);
    token = (res.json() as AuthorizeResult).token;
  });

  it('serves the rewritten master playlist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/master.m3u8?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('mpegurl');
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as string;
    expect(body).toMatch(/^#EXTM3U/);
    // Asset URIs are rewritten to token-scoped URLs — no storage paths leak.
    expect(body).toContain(`/v1/offline/downloads/hls/128k/index.m3u8?token=${token}`);
    expect(body).not.toContain('tracks/');
  });

  it('serves the rendition playlist with rewritten segment URLs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/128k/index.m3u8?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as string;
    expect(body).toContain('#EXT-X-ENDLIST');
    expect(body).toContain(`/v1/offline/downloads/hls/128k/seg-00000.ts?token=${token}`);
  });

  it('serves segments with full and partial (Range) responses', async () => {
    const full = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/128k/seg-00000.ts?token=${token}`,
    });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp2t');
    expect(Number(full.headers['content-length'])).toBe(1024);

    const partial = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/128k/seg-00000.ts?token=${token}`,
      headers: { range: 'bytes=0-99' },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 0-99/1024');
    expect(Number(partial.headers['content-length'])).toBe(100);

    const bad = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/128k/seg-00000.ts?token=${token}`,
      headers: { range: 'bytes=9999-' },
    });
    expect(bad.statusCode).toBe(416);
  });

  it('rejects missing, malformed, and unknown tokens (400/401)', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/v1/offline/downloads/hls/master.m3u8',
    });
    expect(missing.statusCode).toBe(400);
    const malformed = await app.inject({
      method: 'GET',
      url: '/v1/offline/downloads/hls/master.m3u8?token=xyz',
    });
    expect(malformed.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/master.m3u8?token=${'0'.repeat(64)}`,
    });
    expect(unknown.statusCode).toBe(401);
  });

  it('treats expired, revoked, and unknown tokens identically (all 401)', async () => {
    const res = await authorize(entitled, readyTrackId);
    const body = res.json() as AuthorizeResult;
    const t = body.token;

    // Expire the delivery token (the entitlement window stays open).
    await prisma.offlineDownloadAuthorization.update({
      where: { id: body.authorizationId },
      data: { downloadTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/master.m3u8?token=${t}`,
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().title).toBe('Unauthorized');

    // Revoke the grant outright.
    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/offline/downloads/${body.authorizationId}/revoke`,
      headers: auth(entitled),
    });
    expect(revoke.statusCode).toBe(200);
    const revoked = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/master.m3u8?token=${t}`,
    });
    expect(revoked.statusCode).toBe(401);

    // All three failure modes share the same status and title: no probing.
    const unknown = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/master.m3u8?token=${'f'.repeat(64)}`,
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().title).toBe('Unauthorized');
  });

  it('returns 404 for unknown renditions and 400 for path traversal attempts', async () => {
    // Fresh token: an earlier test in this suite rotated the shared one.
    const freshToken = ((await authorize(entitled, readyTrackId)).json() as AuthorizeResult).token;
    const noRendition = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/nope/index.m3u8?token=${freshToken}`,
    });
    expect(noRendition.statusCode).toBe(404);
    const traversal = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/128k/..%2F..%2Fmaster.m3u8?token=${freshToken}`,
    });
    expect([400, 404]).toContain(traversal.statusCode);
  });
});

// --- Revalidation -------------------------------------------------------------------

describe('POST /v1/offline/downloads/:id/revalidate', () => {
  interface RevalidateResult {
    valid: boolean;
    status: string;
    expiresAt: string;
    audioVersion: number;
    currentAudioVersion: number | null;
  }

  async function mint(user: TestUser): Promise<AuthorizeResult> {
    const res = await authorize(user, readyTrackId);
    expect(res.statusCode).toBe(201);
    return res.json() as AuthorizeResult;
  }

  async function revalidate(user: TestUser, id: string) {
    return app.inject({
      method: 'POST',
      url: `/v1/offline/downloads/${id}/revalidate`,
      headers: auth(user),
    });
  }

  it('extends the window (sliding) while the user stays entitled', async () => {
    const grant = await mint(entitled);
    const before = await prisma.offlineDownloadAuthorization.findUniqueOrThrow({
      where: { id: grant.authorizationId },
    });
    const res = await revalidate(entitled, grant.authorizationId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as RevalidateResult;
    expect(body.valid).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.audioVersion).toBe(1);
    expect(body.currentAudioVersion).toBe(1);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThanOrEqual(before.expiresAt.getTime());
  });

  it('requires authentication and is owner-scoped (404 for other users)', async () => {
    const grant = await mint(entitled);
    const unauth = await app.inject({
      method: 'POST',
      url: `/v1/offline/downloads/${grant.authorizationId}/revalidate`,
    });
    expect(unauth.statusCode).toBe(401);
    const foreign = await revalidate(other, grant.authorizationId);
    expect(foreign.statusCode).toBe(404);
    const unknown = await revalidate(entitled, '00000000-0000-4000-8000-000000000000');
    expect(unknown.statusCode).toBe(404);
  });

  it('respects a CANCELED subscription: window kept, never extended', async () => {
    const user = await createUser('canceled');
    const ext = `ext-${Date.now()}-c`;
    await grantActive(user, ext);
    const grant = await mint(user);
    const r = await devEvent(user, {
      providerEventId: `${ext}-cancel`,
      eventType: 'SUBSCRIPTION_CANCELED',
      externalSubscriptionId: ext,
    });
    expect(r.body.subscription.status).toBe('CANCELED');

    const res = await revalidate(user, grant.authorizationId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as RevalidateResult;
    expect(body.status).toBe('entitlement_canceled');
    expect(body.valid).toBe(true);
    // No extension: expiresAt is exactly what authorize minted.
    expect(body.expiresAt).toBe(grant.expiresAt);
  });

  it('revokes the grant on PAST_DUE: fail closed once known', async () => {
    const user = await createUser('pastdue');
    const ext = `ext-${Date.now()}-p`;
    await grantActive(user, ext);
    const grant = await mint(user);
    const r = await devEvent(user, {
      providerEventId: `${ext}-fail`,
      eventType: 'PAYMENT_FAILED',
      externalSubscriptionId: ext,
    });
    expect(r.body.subscription.status).toBe('PAST_DUE');
    // Push the period end beyond the default 3-day grace window: fail closed
    // once the past-due state is known and grace has lapsed.
    await prisma.subscription.updateMany({
      where: { userId: user.id },
      data: { currentPeriodEnd: new Date(Date.now() - 10 * 86400000) },
    });

    const res = await revalidate(user, grant.authorizationId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as RevalidateResult;
    expect(body.status).toBe('entitlement_lost');
    expect(body.valid).toBe(false);

    // New downloads are denied...
    expect((await authorize(user, readyTrackId)).statusCode).toBe(403);
    // ...and the delivery token dies.
    const dl = await app.inject({
      method: 'GET',
      url: `/v1/offline/downloads/hls/master.m3u8?token=${grant.token}`,
    });
    expect(dl.statusCode).toBe(401);
  });

  it('reports expired when the window has lapsed', async () => {
    const grant = await mint(entitled);
    await prisma.offlineDownloadAuthorization.update({
      where: { id: grant.authorizationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await revalidate(entitled, grant.authorizationId);
    const body = res.json() as RevalidateResult;
    expect(body.valid).toBe(false);
    expect(body.status).toBe('expired');
  });

  it('reports version_mismatch after the track audio is replaced', async () => {
    const grant = await mint(entitled);
    await prisma.track.update({
      where: { id: readyTrackId },
      data: { audioVersion: { increment: 1 } },
    });
    try {
      const res = await revalidate(entitled, grant.authorizationId);
      const body = res.json() as RevalidateResult;
      expect(body.valid).toBe(false);
      expect(body.status).toBe('version_mismatch');
      expect(body.audioVersion).toBe(1);
      expect(body.currentAudioVersion).toBe(2);
    } finally {
      await prisma.track.update({ where: { id: readyTrackId }, data: { audioVersion: 1 } });
    }
  });

  it('re-authorize after a version bump pins the new version on the same grant', async () => {
    const first = await mint(entitled);
    await prisma.track.update({
      where: { id: readyTrackId },
      data: { audioVersion: { increment: 1 } },
    });
    try {
      const res = await authorize(entitled, readyTrackId);
      expect(res.statusCode).toBe(201);
      const second = res.json() as AuthorizeResult;
      expect(second.authorizationId).toBe(first.authorizationId);
      expect(second.audioVersion).toBe(2);
      expect(new Date(second.expiresAt).getTime()).toBeGreaterThan(
        new Date(first.expiresAt).getTime(),
      );
    } finally {
      await prisma.track.update({ where: { id: readyTrackId }, data: { audioVersion: 1 } });
    }
  });

  it('revokes the grant when the track is taken down, and delivery fails closed', async () => {
    const grant = await mint(entitled);
    // A second grant that never revalidates: its delivery token must still
    // fail closed on a mid-download takedown (409 from the delivery check).
    const midDownload = await mint(other);
    await prisma.track.update({ where: { id: readyTrackId }, data: { status: 'TAKEDOWN' } });
    try {
      const res = await revalidate(entitled, grant.authorizationId);
      const body = res.json() as RevalidateResult;
      expect(body.valid).toBe(false);
      expect(body.status).toBe('track_unavailable');
      // The grant was revoked on takedown: the delivery token dies with it
      // (invalid/expired/revoked are indistinguishable, all 401).
      const dl = await app.inject({
        method: 'GET',
        url: `/v1/offline/downloads/hls/master.m3u8?token=${grant.token}`,
      });
      expect(dl.statusCode).toBe(401);
      const mid = await app.inject({
        method: 'GET',
        url: `/v1/offline/downloads/hls/master.m3u8?token=${midDownload.token}`,
      });
      expect(mid.statusCode).toBe(409);
    } finally {
      await prisma.track.update({ where: { id: readyTrackId }, data: { status: 'READY' } });
    }
  });

  it('reports revoked after explicit revocation', async () => {
    const grant = await mint(entitled);
    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/offline/downloads/${grant.authorizationId}/revoke`,
      headers: auth(entitled),
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().revokedAt).toBeDefined();

    const res = await revalidate(entitled, grant.authorizationId);
    const body = res.json() as RevalidateResult;
    expect(body.valid).toBe(false);
    expect(body.status).toBe('revoked');
  });

  it('revocation is owner-scoped and requires authentication', async () => {
    const grant = await mint(entitled);
    const unauth = await app.inject({
      method: 'POST',
      url: `/v1/offline/downloads/${grant.authorizationId}/revoke`,
    });
    expect(unauth.statusCode).toBe(401);
    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/offline/downloads/${grant.authorizationId}/revoke`,
      headers: auth(other),
    });
    expect(foreign.statusCode).toBe(404);
  });
});

// --- Offline event sync ----------------------------------------------------------------

describe('POST /v1/playback/offline-events', () => {
  interface SyncResult {
    accepted: string[];
    rejected: { key: string; reason: string }[];
  }

  let grant: AuthorizeResult;
  let issuedAt: number;
  let expiresAt: number;
  let readyDurationMs: number;

  beforeAll(async () => {
    const res = await authorize(entitled, readyTrackId);
    expect(res.statusCode).toBe(201);
    grant = res.json() as AuthorizeResult;
    const row = await prisma.offlineDownloadAuthorization.findUniqueOrThrow({
      where: { id: grant.authorizationId },
    });
    issuedAt = row.issuedAt.getTime();
    expiresAt = row.expiresAt.getTime();
    readyDurationMs = (
      await prisma.track.findUniqueOrThrow({
        where: { id: readyTrackId },
        select: { durationMs: true },
      })
    ).durationMs;
  });

  const evt = (overrides: Record<string, unknown> = {}) => ({
    key: `evt-${Date.now()}-${counter++}`,
    offlineAuthorizationId: grant.authorizationId,
    offlineSessionKey: `session-${Date.now()}-${counter++}`,
    type: 'START' as const,
    occurredAt: new Date(issuedAt + 60_000).toISOString(),
    ...overrides,
  });

  async function sync(user: TestUser, events: Record<string, unknown>[]) {
    return app.inject({
      method: 'POST',
      url: '/v1/playback/offline-events',
      headers: auth(user),
      payload: { events },
    });
  }

  it('accepts valid events and attaches them to one synthetic session', async () => {
    const sessionKey = `session-${Date.now()}-valid`;
    const base = issuedAt + 60_000;
    const res = await sync(entitled, [
      {
        ...evt({ offlineSessionKey: sessionKey }),
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(base).toISOString(),
      },
      {
        ...evt({ offlineSessionKey: sessionKey }),
        type: 'HEARTBEAT',
        positionMs: 6_000,
        occurredAt: new Date(base + 6_000).toISOString(),
      },
      {
        ...evt({ offlineSessionKey: sessionKey }),
        type: 'COMPLETE',
        positionMs: 12_000,
        occurredAt: new Date(base + 12_000).toISOString(),
      },
    ]);
    expect(res.statusCode).toBe(202);
    const body = res.json() as SyncResult;
    expect(body.rejected).toEqual([]);
    expect(body.accepted).toHaveLength(3);

    // Exactly one synthetic server-side session for the offlineSessionKey.
    const sessions = await prisma.playbackSession.findMany({
      where: { userId: entitled.id, offlineSessionKey: sessionKey },
    });
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.trackId).toBe(readyTrackId);
    expect(session.tokenHash).toBeNull(); // synthetic: no delivery token

    const rows = await prisma.playEvent.findMany({
      where: { offlineSessionKey: sessionKey },
      orderBy: { occurredAt: 'asc' },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.eventType)).toEqual(['START', 'HEARTBEAT', 'COMPLETE']);
    for (const row of rows) {
      expect(row.sessionId).toBe(session.id); // non-null: joins session aggregates
      expect(row.userId).toBe(entitled.id);
      expect(row.trackId).toBe(readyTrackId);
      expect(row.offlineAuthorizationId).toBe(grant.authorizationId);
      // Analytics bucket on actual playback time, not upload time.
      expect(row.createdAt.getTime()).toBe(row.occurredAt!.getTime());
    }
    expect(rows[0].createdAt.toISOString()).toBe(new Date(base).toISOString());
  });

  it('reuses the synthetic session across uploads for the same session key', async () => {
    const sessionKey = `session-${Date.now()}-split`;
    const base = issuedAt + 120_000;
    const first = await sync(entitled, [
      {
        ...evt({ offlineSessionKey: sessionKey }),
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(base).toISOString(),
      },
    ]);
    expect((first.json() as SyncResult).rejected).toEqual([]);
    const second = await sync(entitled, [
      {
        ...evt({ offlineSessionKey: sessionKey }),
        type: 'HEARTBEAT',
        positionMs: 6_000,
        occurredAt: new Date(base + 30_000).toISOString(),
      },
      {
        ...evt({ offlineSessionKey: sessionKey }),
        type: 'COMPLETE',
        positionMs: 12_000,
        occurredAt: new Date(base + 60_000).toISOString(),
      },
    ]);
    const body = second.json() as SyncResult;
    expect(body.rejected).toEqual([]);
    expect(body.accepted).toHaveLength(2);

    const sessions = await prisma.playbackSession.findMany({
      where: { userId: entitled.id, offlineSessionKey: sessionKey },
    });
    expect(sessions).toHaveLength(1);
    const rows = await prisma.playEvent.findMany({
      where: { offlineSessionKey: sessionKey },
      orderBy: { occurredAt: 'asc' },
    });
    expect(rows.map((r) => r.eventType)).toEqual(['START', 'HEARTBEAT', 'COMPLETE']);
  });

  it('is idempotent: replayed keys are accepted without creating duplicate rows', async () => {
    const key = `evt-replay-${Date.now()}`;
    const sessionKey = `session-${Date.now()}-replay`;
    const payload = evt({ key, offlineSessionKey: sessionKey, type: 'START' });
    const first = await sync(entitled, [payload]);
    expect((first.json() as SyncResult).accepted).toEqual([key]);
    const second = await sync(entitled, [payload]);
    const body = second.json() as SyncResult;
    expect(body.accepted).toEqual([key]);
    expect(body.rejected).toEqual([]);
    const count = await prisma.playEvent.count({ where: { offlineEventKey: key } });
    expect(count).toBe(1);
  });

  it('rejects implausible session sequences', async () => {
    const base = issuedAt + 180_000;

    // COMPLETE without a START.
    const noStart = await sync(entitled, [
      evt({
        offlineSessionKey: `session-${Date.now()}-ns`,
        type: 'COMPLETE',
        positionMs: 12_000,
        occurredAt: new Date(base).toISOString(),
      }),
    ]);
    expect((noStart.json() as SyncResult).rejected[0].reason).toBe('complete_without_start');

    // HEARTBEAT without a START.
    const noStartHb = await sync(entitled, [
      evt({
        offlineSessionKey: `session-${Date.now()}-nh`,
        type: 'HEARTBEAT',
        positionMs: 6_000,
        occurredAt: new Date(base).toISOString(),
      }),
    ]);
    expect((noStartHb.json() as SyncResult).rejected[0].reason).toBe('heartbeat_without_start');

    // Duplicate START within one session (across two uploads).
    const dupKey = `session-${Date.now()}-dup`;
    await sync(entitled, [
      evt({
        offlineSessionKey: dupKey,
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(base).toISOString(),
      }),
    ]);
    const dupStart = await sync(entitled, [
      evt({
        offlineSessionKey: dupKey,
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(base + 1_000).toISOString(),
      }),
    ]);
    expect((dupStart.json() as SyncResult).rejected[0].reason).toBe('duplicate_start');

    // Duplicate COMPLETE.
    const dupComplete = await sync(entitled, [
      evt({
        offlineSessionKey: dupKey,
        type: 'COMPLETE',
        positionMs: 12_000,
        occurredAt: new Date(base + 60_000).toISOString(),
      }),
      evt({
        offlineSessionKey: dupKey,
        type: 'COMPLETE',
        positionMs: 12_000,
        occurredAt: new Date(base + 61_000).toISOString(),
      }),
    ]);
    const dupCompleteBody = dupComplete.json() as SyncResult;
    expect(dupCompleteBody.accepted).toHaveLength(1);
    expect(dupCompleteBody.rejected[0].reason).toBe('duplicate_complete');

    // Out-of-order timestamps within one upload.
    const oooKey = `session-${Date.now()}-ooo`;
    const ooo = await sync(entitled, [
      evt({
        offlineSessionKey: oooKey,
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(base + 5_000).toISOString(),
      }),
      evt({
        offlineSessionKey: oooKey,
        type: 'HEARTBEAT',
        positionMs: 1_000,
        occurredAt: new Date(base).toISOString(),
      }),
    ]);
    // Both share the same session key prefix but the second sorts first and
    // is a HEARTBEAT without a START; the START itself is accepted.
    const oooBody = ooo.json() as SyncResult;
    expect(oooBody.rejected[0].reason).toBe('heartbeat_without_start');
    expect(oooBody.accepted).toHaveLength(1);

    // Regressed position (backward seek): legitimate, must be accepted.
    // Seeks generate no events, so the heartbeat after a backward seek
    // reports an earlier position; Phase 15 clamps the delta to [0, 35s].
    const regKey = `session-${Date.now()}-reg`;
    const reg = await sync(entitled, [
      evt({
        offlineSessionKey: regKey,
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(base).toISOString(),
      }),
      evt({
        offlineSessionKey: regKey,
        type: 'HEARTBEAT',
        positionMs: 6_000,
        occurredAt: new Date(base + 30_000).toISOString(),
      }),
      evt({
        offlineSessionKey: regKey,
        type: 'HEARTBEAT',
        positionMs: 2_000,
        occurredAt: new Date(base + 60_000).toISOString(),
      }),
    ]);
    const regBody = reg.json() as SyncResult;
    expect(regBody.rejected).toEqual([]);
    expect(regBody.accepted).toHaveLength(3);

    // Position past the track duration (+tolerance).
    const oob = await sync(entitled, [
      evt({
        type: 'START',
        positionMs: readyDurationMs + 60_000,
        occurredAt: new Date(base).toISOString(),
      }),
    ]);
    expect((oob.json() as SyncResult).rejected[0].reason).toBe('position_out_of_bounds');

    // HEARTBEAT after COMPLETE: the engine stops the cadence before
    // reporting COMPLETE, so this cannot be genuine.
    const hacKey = `session-${Date.now()}-hac`;
    const hac = await sync(entitled, [
      evt({
        offlineSessionKey: hacKey,
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(base).toISOString(),
      }),
      evt({
        offlineSessionKey: hacKey,
        type: 'COMPLETE',
        positionMs: 12_000,
        occurredAt: new Date(base + 60_000).toISOString(),
      }),
      evt({
        offlineSessionKey: hacKey,
        type: 'HEARTBEAT',
        positionMs: 12_000,
        occurredAt: new Date(base + 90_000).toISOString(),
      }),
    ]);
    const hacBody = hac.json() as SyncResult;
    expect(hacBody.accepted).toHaveLength(2);
    expect(hacBody.rejected[0].reason).toBe('heartbeat_after_complete');
  });

  it('validates in occurredAt order regardless of wire order', async () => {
    // Idempotent retries and split batches may arrive shuffled; the server
    // sorts by occurredAt before sequence validation.
    const base = issuedAt + 60_000;
    const sessionKey = `session-${Date.now()}-shuffle`;
    const res = await sync(entitled, [
      evt({
        offlineSessionKey: sessionKey,
        type: 'HEARTBEAT',
        positionMs: 6_000,
        occurredAt: new Date(base + 30_000).toISOString(),
      }),
      evt({
        offlineSessionKey: sessionKey,
        type: 'COMPLETE',
        positionMs: 12_000,
        occurredAt: new Date(base + 60_000).toISOString(),
      }),
      evt({
        offlineSessionKey: sessionKey,
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(base).toISOString(),
      }),
    ]);
    const body = res.json() as SyncResult;
    expect(body.rejected).toEqual([]);
    expect(body.accepted).toHaveLength(3);
    const rows = await prisma.playEvent.findMany({
      where: { offlineSessionKey: sessionKey },
      orderBy: { occurredAt: 'asc' },
    });
    expect(rows.map((r) => r.eventType)).toEqual(['START', 'HEARTBEAT', 'COMPLETE']);
  });

  it('treats duplicate keys inside one batch as idempotent', async () => {
    const key = `evt-dupbatch-${Date.now()}`;
    const sessionKey = `session-${Date.now()}-dupbatch`;
    const res = await sync(entitled, [
      evt({
        key,
        offlineSessionKey: sessionKey,
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(issuedAt + 90_000).toISOString(),
      }),
      evt({
        key,
        offlineSessionKey: sessionKey,
        type: 'START',
        positionMs: 0,
        occurredAt: new Date(issuedAt + 90_000).toISOString(),
      }),
    ]);
    const body = res.json() as SyncResult;
    expect(body.rejected).toEqual([]);
    expect(body.accepted).toEqual([key, key]);
    const count = await prisma.playEvent.count({ where: { offlineEventKey: key } });
    expect(count).toBe(1);
  });

  it('rejects one session key bound to two different authorizations', async () => {
    // A second grant for a different track: sessionKey reuse across
    // tracks/authorizations is rejected.
    await writeHlsPackage(noAssetsTrackId);
    const otherGrantRes = await authorize(entitled, noAssetsTrackId);
    expect(otherGrantRes.statusCode).toBe(201);
    const otherGrant = otherGrantRes.json() as AuthorizeResult;
    // noAssetsTrackId has no HLS assets, but authorization itself succeeds.
    const sessionKey = `session-${Date.now()}-mismatch`;
    const base = new Date(issuedAt + 240_000).toISOString();
    const res = await sync(entitled, [
      { ...evt({ offlineSessionKey: sessionKey }), type: 'START', positionMs: 0, occurredAt: base },
      {
        ...evt({
          offlineSessionKey: sessionKey,
          offlineAuthorizationId: otherGrant.authorizationId,
        }),
        type: 'START',
        positionMs: 0,
        occurredAt: base,
      },
    ]);
    const body = res.json() as SyncResult;
    expect(body.accepted).toEqual([]);
    expect(body.rejected).toHaveLength(2);
    expect(body.rejected[0].reason).toBe('session_authorization_mismatch');
  });

  it('rejects events outside the authorization window and in the future', async () => {
    // Shrink this grant's window into the past so "after expiry" is a
    // past timestamp rather than tripping the future-skew guard.
    const pastIssued = new Date(Date.now() - 2 * 3600_000);
    const pastExpiry = new Date(Date.now() - 3600_000);
    await prisma.offlineDownloadAuthorization.update({
      where: { id: grant.authorizationId },
      data: { issuedAt: pastIssued, expiresAt: pastExpiry },
    });
    try {
      const before = await sync(entitled, [
        evt({ occurredAt: new Date(pastIssued.getTime() - 60_000).toISOString() }),
      ]);
      expect((before.json() as SyncResult).rejected[0].reason).toBe('outside_authorization_window');

      const after = await sync(entitled, [
        evt({ occurredAt: new Date(pastExpiry.getTime() + 60_000).toISOString() }),
      ]);
      expect((after.json() as SyncResult).rejected[0].reason).toBe('outside_authorization_window');

      const future = await sync(entitled, [
        evt({ occurredAt: new Date(Date.now() + 60 * 60_000).toISOString() }),
      ]);
      expect((future.json() as SyncResult).rejected[0].reason).toBe('occurred_at_in_future');
    } finally {
      await prisma.offlineDownloadAuthorization.update({
        where: { id: grant.authorizationId },
        data: { issuedAt: new Date(issuedAt), expiresAt: new Date(expiresAt) },
      });
    }
  });

  it('rejects events for unknown, other-user, and revoked authorizations', async () => {
    const unknown = await sync(entitled, [
      evt({ offlineAuthorizationId: '00000000-0000-4000-8000-000000000000' }),
    ]);
    expect((unknown.json() as SyncResult).rejected[0].reason).toBe('authorization_not_found');

    const foreign = await sync(other, [evt()]);
    expect((foreign.json() as SyncResult).rejected[0].reason).toBe('authorization_not_found');

    // Revoke, then upload an event that happened after the revocation.
    const grantRes = await authorize(entitled, readyTrackId);
    const g = grantRes.json() as AuthorizeResult;
    await app.inject({
      method: 'POST',
      url: `/v1/offline/downloads/${g.authorizationId}/revoke`,
      headers: auth(entitled),
    });
    const row = await prisma.offlineDownloadAuthorization.findUniqueOrThrow({
      where: { id: g.authorizationId },
    });
    const revoked = await sync(entitled, [
      {
        ...evt({ offlineAuthorizationId: g.authorizationId }),
        occurredAt: new Date(row.revokedAt!.getTime() + 60_000).toISOString(),
      },
    ]);
    expect((revoked.json() as SyncResult).rejected[0].reason).toBe('authorization_revoked');
  });

  it('rejects malformed payloads at the HTTP layer', async () => {
    const empty = await sync(entitled, []);
    expect(empty.statusCode).toBe(400);
    const negative = await sync(entitled, [evt({ positionMs: -5 })]);
    expect(negative.statusCode).toBe(400);
    const unauth = await app.inject({
      method: 'POST',
      url: '/v1/playback/offline-events',
      payload: { events: [evt()] },
    });
    expect(unauth.statusCode).toBe(401);
  });

  it('offline events join session aggregates via their synthetic session', async () => {
    // Royalty/session analytics group by playback session id. Offline events
    // carry a non-null sessionId pointing at a synthetic session
    // (tokenHash null), so they are counted as streams exactly like online
    // plays while remaining distinguishable from online sessions.
    const count = await prisma.playEvent.count({
      where: { offlineEventKey: { not: null } },
    });
    expect(count).toBeGreaterThan(0);
    const rows = await prisma.playEvent.findMany({
      where: { offlineEventKey: { not: null } },
      select: {
        sessionId: true,
        session: { select: { tokenHash: true, offlineSessionKey: true } },
      },
    });
    for (const row of rows) {
      expect(row.sessionId).not.toBeNull();
      expect(row.session.tokenHash).toBeNull();
      expect(row.session.offlineSessionKey).not.toBeNull();
    }
    // Online sessions (real delivery tokens) never carry offline keys.
    const onlineLeak = await prisma.playEvent.count({
      where: { offlineEventKey: { not: null }, session: { tokenHash: { not: null } } },
    });
    expect(onlineLeak).toBe(0);
  });
});

// --- Re-ingestion bumps audioVersion ----------------------------------------------------

describe('processTrackAudio (Phase 25: audioVersion)', () => {
  const actor = (): AuthUser => ({ id: artistOwner.id, email: artistOwner.email, role: 'ARTIST' });

  it('leaves audioVersion at 1 on first processing, increments on audio replacement', async () => {
    const track = await prisma.track.create({
      data: { title: 'Version Bump Track', artistId, durationMs: 3000 },
      select: { id: true },
    });
    const v1 = path.join(fixturesDir, 'v1.wav');
    const v2 = path.join(fixturesDir, 'v2.wav');
    await synthAudio(v1, 2, 440);
    await synthAudio(v2, 2, 660);

    await serviceUpload(track.id, v1, actor());
    await processTrackAudio(track.id, ingestionDeps);
    const afterFirst = await prisma.track.findUniqueOrThrow({ where: { id: track.id } });
    expect(afterFirst.audioStatus).toBe('READY');
    expect(afterFirst.audioVersion).toBe(1);

    // Artist replaces the audio of the published track.
    await serviceUpload(track.id, v2, actor());
    await processTrackAudio(track.id, ingestionDeps);
    const afterReplace = await prisma.track.findUniqueOrThrow({ where: { id: track.id } });
    expect(afterReplace.audioStatus).toBe('READY');
    expect(afterReplace.audioVersion).toBe(2);
  }, 120_000);

  it('does not bump audioVersion when processing fails', async () => {
    const track = await prisma.track.create({
      data: { title: 'Failed Bump Track', artistId, durationMs: 3000 },
      select: { id: true },
    });
    const good = path.join(fixturesDir, 'good.wav');
    await synthAudio(good, 2, 440);
    await serviceUpload(track.id, good, actor());
    await processTrackAudio(track.id, ingestionDeps);
    expect((await prisma.track.findUniqueOrThrow({ where: { id: track.id } })).audioVersion).toBe(
      1,
    );

    // Simulate a failed re-processing: delete the staged source so the
    // pipeline fails after claiming.
    await serviceUpload(track.id, good, actor());
    const src = await prisma.track.findUniqueOrThrow({ where: { id: track.id } });
    await ingestionDeps.storage.deleteObject(src.audioSourceKey!);
    await processTrackAudio(track.id, ingestionDeps);
    const after = await prisma.track.findUniqueOrThrow({ where: { id: track.id } });
    expect(after.audioStatus).toBe('FAILED');
    expect(after.audioVersion).toBe(1);
  }, 120_000);
});
