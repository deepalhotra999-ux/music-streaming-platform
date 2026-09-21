/**
 * Phase 7 — streaming infrastructure tests. Full HTTP stack via `app.inject()`
 * against TEST_DATABASE_URL — never the dev DB.
 *
 * Covers: track availability, auth/entitlement checks, playback-session
 * creation, invalid track handling, expired/invalid sessions, HLS manifest
 * rewriting, segment delivery with Range support, streaming error handling,
 * and play events. Pure unit tests (range parser, playlist rewriting, key
 * safety) live at the bottom of this file.
 *
 * Cleanup is scoped to `@streaming-test.local` addresses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { parseRange } from '../src/modules/streaming/routes.js';
import {
  assertSafeKey,
  masterKey,
  mediaPlaylistKey,
  segmentKey,
} from '../src/modules/streaming/storage.js';
import { buildMasterPlaylist, rewritePlaylistUris } from '../src/modules/streaming/hls.js';

// --- Entitlement stub -------------------------------------------------------
// Most tests use the real allow-all placeholder; the denial path flips this.
let denyEntitlement = false;
vi.mock('../src/modules/streaming/entitlements.js', () => ({
  checkPlaybackEntitlement: async () =>
    denyEntitlement
      ? { allowed: false, reason: 'test denial: subscription required' }
      : { allowed: true, reason: 'test allow' },
}));

const TEST_DOMAIN = '@streaming-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase7-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;
let audioDir: string;

interface TestUser {
  id: string;
  email: string;
  token: string;
}

async function createUser(tag: string): Promise<TestUser> {
  const email = testEmail(tag);
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: `${tag} User` },
  });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().user.id as string;
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
  await prisma.playbackSession.deleteMany({ where: userWhere });
  await prisma.track.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.refreshToken.deleteMany({ where: userWhere });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
}

// --- HLS fixture ------------------------------------------------------------

const SEG0_STR = '0123456789ABCDEF'.repeat(64); // 1024 bytes, ASCII-safe
const SEG1_STR = 'abcdef'.repeat(85) + 'ab'; // 512 bytes, ASCII-safe
const SEG0 = Buffer.from(SEG0_STR, 'utf8');
const SEG1 = Buffer.from(SEG1_STR, 'utf8');

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

// --- Suite fixtures ----------------------------------------------------------

let listener: TestUser;
let other: TestUser;
let readyTrackId: string;
let noAssetsTrackId: string;
let processingTrackId: string;
let takedownTrackId: string;

beforeAll(async () => {
  audioDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase7-audio-'));
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    RATE_LIMIT_LOGIN: '1000',
    RATE_LIMIT_REGISTER: '1000',
    RATE_LIMIT_REFRESH: '1000',
    RATE_LIMIT_LOGOUT: '1000',
    RATE_LIMIT_API: '10000',
    RATE_LIMIT_STREAMING: '10000',
    AUDIO_STORAGE_DRIVER: 'local',
    AUDIO_STORAGE_DIR: audioDir,
    PLAYBACK_SESSION_TTL_SECONDS: '900',
  });
  app = await buildApp(config);
  await scopedClean();

  listener = await createUser('listener');
  other = await createUser('other');

  const artist = await prisma.artist.create({
    data: { name: 'Phase7 Artist', ownerUserId: listener.id },
    select: { id: true },
  });
  const mkTrack = (title: string, status: 'READY' | 'PROCESSING' | 'TAKEDOWN') =>
    prisma.track.create({
      data: { title, artistId: artist.id, durationMs: 12_000, status },
      select: { id: true },
    });

  readyTrackId = (await mkTrack('Ready Track', 'READY')).id;
  noAssetsTrackId = (await mkTrack('Ready But No Assets', 'READY')).id;
  processingTrackId = (await mkTrack('Processing Track', 'PROCESSING')).id;
  takedownTrackId = (await mkTrack('Takedown Track', 'TAKEDOWN')).id;

  await writeHlsPackage(readyTrackId);
});

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
  await fs.rm(audioDir, { recursive: true, force: true });
});

async function createSession(user: TestUser, trackId: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/playback/sessions',
    headers: auth(user),
    payload: { trackId },
  });
}

function expectProblem(res: { statusCode: number; headers: Record<string, unknown> }) {
  expect(String(res.headers['content-type'])).toMatch('application/problem+json');
  expect(res.statusCode).toBeGreaterThanOrEqual(400);
}

// ---------------------------------------------------------------------------
// Playback session creation
// ---------------------------------------------------------------------------

describe('POST /v1/playback/sessions', () => {
  it('creates a session for a READY track with assets', async () => {
    const res = await createSession(listener, readyTrackId);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.hlsUrl).toBe(`/v1/playback/hls/master.m3u8?token=${body.token}`);
    // The token is the only credential: no permanent URL, no track id leak.
    expect(body.hlsUrl).not.toContain(readyTrackId);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/playback/sessions',
      payload: { trackId: readyTrackId },
    });
    expect(res.statusCode).toBe(401);
    expectProblem(res);
  });

  it('rejects a malformed track id with 400', async () => {
    const res = await createSession(listener, 'not-a-uuid');
    expect(res.statusCode).toBe(400);
    expectProblem(res);
  });

  it('returns 404 for an unknown track', async () => {
    const res = await createSession(listener, '00000000-0000-4000-8000-000000000000');
    expect(res.statusCode).toBe(404);
    expectProblem(res);
    expect(res.json().detail).toMatch(/not found/i);
  });

  it.each([
    ['PROCESSING', () => processingTrackId],
    ['TAKEDOWN', () => takedownTrackId],
  ])('returns 409 when track status is %s', async (_status, getId) => {
    const res = await createSession(listener, getId());
    expect(res.statusCode).toBe(409);
    expectProblem(res);
  });

  it('returns 409 when the track is READY but has no audio assets', async () => {
    const res = await createSession(listener, noAssetsTrackId);
    expect(res.statusCode).toBe(409);
    expectProblem(res);
    expect(res.json().detail).toMatch(/audio.*not available/i);
  });

  it('returns 403 when the entitlement check denies playback', async () => {
    denyEntitlement = true;
    try {
      const res = await createSession(listener, readyTrackId);
      expect(res.statusCode).toBe(403);
      expectProblem(res);
      expect(res.json().detail).toMatch(/test denial/);
    } finally {
      denyEntitlement = false;
    }
  });
});

// ---------------------------------------------------------------------------
// HLS manifest delivery
// ---------------------------------------------------------------------------

describe('GET /v1/playback/hls/master.m3u8', () => {
  it('serves a rewritten master playlist for a valid session', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/master.m3u8?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch('application/vnd.apple.mpegurl');
    const lines = res.body.split('\n').map((l: string) => l.trim());
    // Asset URIs are session-scoped; the bare relative name must not survive.
    expect(lines).toContain(`/v1/playback/hls/128k/index.m3u8?token=${token}`);
    expect(lines).not.toContain('128k/index.m3u8');
    // No storage internals leak: no track id, no filesystem path.
    expect(res.body).not.toContain(readyTrackId);
    expect(res.body).not.toContain(audioDir);
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('serves a rewritten media playlist', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/index.m3u8?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split('\n').map((l: string) => l.trim());
    expect(lines).toContain(`/v1/playback/hls/128k/seg-00000.ts?token=${token}`);
    expect(lines).toContain(`/v1/playback/hls/128k/seg-00001.ts?token=${token}`);
    expect(lines).not.toContain('seg-00000.ts');
    // Directives pass through untouched.
    expect(res.body).toContain('#EXT-X-ENDLIST');
  });

  it('rejects a missing token with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/playback/hls/master.m3u8' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a malformed token with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/playback/hls/master.m3u8?token=short',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown token with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/master.m3u8?token=${'a'.repeat(64)}`,
    });
    expect(res.statusCode).toBe(401);
    expectProblem(res);
  });

  it('rejects an expired session with 401 on master and media playlist', async () => {
    const created = await createSession(listener, readyTrackId);
    const { id, token } = created.json();
    await prisma.playbackSession.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    for (const url of [
      `/v1/playback/hls/master.m3u8?token=${token}`,
      `/v1/playback/hls/128k/index.m3u8?token=${token}`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expectProblem(res);
    }
  });

  it('returns 404 for an unknown rendition', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/64k/index.m3u8?token=${token}`,
    });
    expect(res.statusCode).toBe(404);
    expectProblem(res);
  });
});

// ---------------------------------------------------------------------------
// Segment delivery + Range support
// ---------------------------------------------------------------------------

describe('GET /v1/playback/hls/:rendition/:segment', () => {
  it('serves full segment bytes with 200', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/seg-00000.ts?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp2t');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(1024);
    // Fixture segments are ASCII on purpose: light-my-request utf8-decodes
    // res.body, so byte-exact comparison needs ASCII-safe content.
    expect(res.body).toBe(SEG0_STR);
  });

  it('serves a byte range with 206 and a correct Content-Range', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/seg-00000.ts?token=${token}`,
      headers: { range: 'bytes=0-99' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-99/1024');
    expect(Number(res.headers['content-length'])).toBe(100);
    expect(res.body).toBe(SEG0_STR.substring(0, 100));
  });

  it('supports open-ended and suffix ranges', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const open = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/seg-00001.ts?token=${token}`,
      headers: { range: 'bytes=500-' },
    });
    expect(open.statusCode).toBe(206);
    expect(open.headers['content-range']).toBe('bytes 500-511/512');

    const suffix = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/seg-00001.ts?token=${token}`,
      headers: { range: 'bytes=-10' },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers['content-range']).toBe('bytes 502-511/512');
    expect(suffix.body).toBe(SEG1_STR.substring(502));
  });

  it('returns 416 for an unsatisfiable range', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/seg-00000.ts?token=${token}`,
      headers: { range: 'bytes=2000-3000' },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */1024');
    expectProblem(res);
  });

  it('returns 404 for a missing segment', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/seg-99999.ts?token=${token}`,
    });
    expect(res.statusCode).toBe(404);
    expectProblem(res);
  });

  it('rejects an expired session with 401', async () => {
    const created = await createSession(listener, readyTrackId);
    const { id, token } = created.json();
    await prisma.playbackSession.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/seg-00000.ts?token=${token}`,
    });
    expect(res.statusCode).toBe(401);
    expectProblem(res);
  });

  it('rejects path traversal in the segment param with 400', async () => {
    const created = await createSession(listener, readyTrackId);
    const { token } = created.json();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/hls/128k/..%2F..%2Fmaster.m3u8?token=${token}`,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Play events
// ---------------------------------------------------------------------------

describe('POST /v1/playback/sessions/:id/events', () => {
  it('records START and HEARTBEAT events', async () => {
    const created = await createSession(listener, readyTrackId);
    const { id } = created.json();

    const start = await app.inject({
      method: 'POST',
      url: `/v1/playback/sessions/${id}/events`,
      headers: auth(listener),
      payload: { type: 'START', positionMs: 0 },
    });
    expect(start.statusCode).toBe(201);
    expect(start.json().id).toMatch(/^[0-9a-f-]{36}$/);

    const beat = await app.inject({
      method: 'POST',
      url: `/v1/playback/sessions/${id}/events`,
      headers: auth(listener),
      payload: { type: 'HEARTBEAT', positionMs: 6000 },
    });
    expect(beat.statusCode).toBe(201);

    const rows = await prisma.playEvent.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.eventType)).toEqual(['START', 'HEARTBEAT']);
    expect(rows[1].positionMs).toBe(6000);
    expect(rows[0].trackId).toBe(readyTrackId);
  });

  it('requires authentication', async () => {
    const created = await createSession(listener, readyTrackId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playback/sessions/${created.json().id}/events`,
      payload: { type: 'START' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for another user\u2019s session (no existence leak)', async () => {
    const created = await createSession(listener, readyTrackId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playback/sessions/${created.json().id}/events`,
      headers: auth(other),
      payload: { type: 'START' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 for an expired session', async () => {
    const created = await createSession(listener, readyTrackId);
    const { id } = created.json();
    await prisma.playbackSession.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playback/sessions/${id}/events`,
      headers: auth(listener),
      payload: { type: 'START' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown event type with 400', async () => {
    const created = await createSession(listener, readyTrackId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/playback/sessions/${created.json().id}/events`,
      headers: auth(listener),
      payload: { type: 'DANCE' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: range parser, playlist rewriting, storage keys
// ---------------------------------------------------------------------------

describe('parseRange', () => {
  it('parses a closed range', () => {
    expect(parseRange('bytes=0-99', 1024)).toEqual({ start: 0, end: 99 });
  });
  it('parses an open-ended range', () => {
    expect(parseRange('bytes=100-', 1024)).toEqual({ start: 100, end: 1023 });
  });
  it('parses a suffix range', () => {
    expect(parseRange('bytes=-10', 1024)).toEqual({ start: 1014, end: 1023 });
  });
  it('returns null when no range is requested', () => {
    expect(parseRange(undefined, 1024)).toBeNull();
  });
  it.each([['bytes=2000-3000'], ['bytes=500-100'], ['bytes=-0'], ['items=0-1'], ['bytes=']])(
    'marks %s unsatisfiable against a 1024-byte object',
    (header) => {
      expect(parseRange(header, 1024)).toBe('unsatisfiable');
    },
  );
});

describe('rewritePlaylistUris', () => {
  it('rewrites URI lines and keeps directives', () => {
    const out = rewritePlaylistUris(
      '#EXTM3U\n#EXTINF:6.0,\nseg-00000.ts\n\n#EXT-X-ENDLIST',
      (uri) => `/hls/${uri}?token=t`,
    );
    expect(out).toBe('#EXTM3U\n#EXTINF:6.0,\n/hls/seg-00000.ts?token=t\n\n#EXT-X-ENDLIST');
  });
});

describe('buildMasterPlaylist', () => {
  it('lists renditions with stream-inf tags', () => {
    const master = buildMasterPlaylist([{ name: '128k', bandwidth: 128_000 }]);
    expect(master.startsWith('#EXTM3U')).toBe(true);
    expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=128000');
    expect(master).toContain('128k/index.m3u8');
  });
});

describe('storage keys', () => {
  it('builds the documented key layout', () => {
    expect(masterKey('t1')).toBe('tracks/t1/hls/master.m3u8');
    expect(mediaPlaylistKey('t1', '128k')).toBe('tracks/t1/hls/128k/index.m3u8');
    expect(segmentKey('t1', '128k', 'seg-00000.ts')).toBe('tracks/t1/hls/128k/seg-00000.ts');
  });
  it('rejects unsafe keys', () => {
    expect(() => assertSafeKey('../evil')).toThrow();
    expect(() => assertSafeKey('/absolute')).toThrow();
    expect(() => assertSafeKey('tracks/t1/../../x')).toThrow();
    expect(() => assertSafeKey(masterKey('t1'))).not.toThrow();
  });
});
