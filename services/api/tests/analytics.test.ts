/**
 * Phase 15 — artist analytics & reporting tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB). Playback sessions and play events are seeded directly through
 * Prisma with fully controlled timestamps and positions, so every metric
 * expectation is deterministic.
 *
 * Covers: artist ownership isolation (data + 403), date-range filtering
 * (7d/28d/90d/all), stream counting (COMPLETE deduped per session),
 * unique-listener calculation, listening-time calculation (heartbeat
 * deltas, seek caps, backward seeks), heartbeat handling (no stream
 * inflation), failed/incomplete playback handling, track/album filtering
 * (+ 404 for foreign ids), empty datasets, ADMIN access (artist-scoped +
 * platform-wide), LISTENER denial (403), unauthenticated (401),
 * pagination, trend buckets, and recent activity (no listener identity).
 *
 * Metric definitions under test (see ADR-011):
 * - stream: session with >= 1 COMPLETE (counted once per session)
 * - unique listeners: COUNT(DISTINCT user_id) over in-scope sessions
 * - listening time: sum over consecutive events of
 *   clamp(pos[i] - pos[i-1], 0, 35000ms)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';

const TEST_DOMAIN = '@analytics-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase15-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;

interface Fixture {
  userId: string;
  token: string;
  artistId: string;
  albumId: string;
  trackIds: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (n: number, jitterMs = 0) => new Date(NOW - n * DAY - jitterMs);

async function registerAndLogin(email: string, role: 'LISTENER' | 'ARTIST' | 'ADMIN') {
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: email },
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
  return { userId, token: login.json().tokens.accessToken as string };
}

async function makeArtistFixture(
  tag: string,
  trackCount: number,
  albumCount: number,
): Promise<Fixture> {
  const { userId, token } = await registerAndLogin(testEmail(tag), 'ARTIST');
  const artist = await prisma.artist.create({
    data: { name: `Analytics ${tag}`, ownerUserId: userId },
  });
  const albumIds: string[] = [];
  for (let i = 0; i < albumCount; i++) {
    const album = await prisma.album.create({
      data: { title: `Album ${tag}-${i}`, artistId: artist.id },
    });
    albumIds.push(album.id);
  }
  const trackIds: string[] = [];
  for (let i = 0; i < trackCount; i++) {
    const track = await prisma.track.create({
      data: {
        title: `Track ${tag}-${i}`,
        artistId: artist.id,
        albumId: albumIds.length > 0 ? albumIds[i % albumIds.length] : null,
        durationMs: 180000,
        status: 'READY',
      },
    });
    trackIds.push(track.id);
  }
  return { userId, token, artistId: artist.id, albumId: albumIds[0] ?? '', trackIds };
}

type EventType = 'START' | 'HEARTBEAT' | 'COMPLETE' | 'ERROR';

interface SeedEvent {
  type: EventType;
  positionMs?: number;
  /** ms after session start */
  atMs: number;
}

async function seedSession(opts: {
  userId: string;
  trackId: string;
  createdAt: Date;
  events: SeedEvent[];
}): Promise<string> {
  const session = await prisma.playbackSession.create({
    data: {
      userId: opts.userId,
      trackId: opts.trackId,
      tokenHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      expiresAt: new Date(opts.createdAt.getTime() + 15 * 60 * 1000),
      createdAt: opts.createdAt,
    },
  });
  for (const [i, ev] of opts.events.entries()) {
    await prisma.playEvent.create({
      data: {
        sessionId: session.id,
        userId: opts.userId,
        trackId: opts.trackId,
        eventType: ev.type,
        positionMs: ev.positionMs ?? null,
        createdAt: new Date(opts.createdAt.getTime() + ev.atMs + i), // +i keeps ordering deterministic
      },
    });
  }
  return session.id;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let a1: Fixture; // main artist: 3 tracks, 2 albums
let a2: Fixture; // second artist: 1 track (isolation)
let listener: { userId: string; token: string };
let listener2: { userId: string; token: string };
let admin: { userId: string; token: string };
let emptyArtist: Fixture;

beforeAll(async () => {
  const config = loadConfig();
  app = await buildApp(config);

  a1 = await makeArtistFixture('a1', 3, 2);
  a2 = await makeArtistFixture('a2', 1, 1);
  emptyArtist = await makeArtistFixture('empty', 1, 0);
  listener = await registerAndLogin(testEmail('listener'), 'LISTENER');
  listener2 = await registerAndLogin(testEmail('listener2'), 'LISTENER');
  admin = await registerAndLogin(testEmail('admin'), 'ADMIN');

  const [t0, t1, t2] = a1.trackIds;

  // Session S1 (2 days ago): full play of t0 by listener — 90s listened, 1 stream.
  await seedSession({
    userId: listener.userId,
    trackId: t0,
    createdAt: daysAgo(2),
    events: [
      { type: 'START', positionMs: 0, atMs: 0 },
      { type: 'HEARTBEAT', positionMs: 30000, atMs: 30000 },
      { type: 'HEARTBEAT', positionMs: 60000, atMs: 60000 },
      { type: 'COMPLETE', positionMs: 90000, atMs: 90000 },
    ],
  });

  // Session S2 (2 days ago): same listener replays t0 — repeated heartbeats,
  // duplicate COMPLETE rows, and a duplicate heartbeat at the same position.
  // Must still count as exactly 1 stream and 1 listener.
  await seedSession({
    userId: listener.userId,
    trackId: t0,
    createdAt: daysAgo(2, 60_000),
    events: [
      { type: 'START', positionMs: 0, atMs: 0 },
      { type: 'HEARTBEAT', positionMs: 30000, atMs: 30000 },
      { type: 'HEARTBEAT', positionMs: 30000, atMs: 31000 }, // duplicate: +0ms
      { type: 'HEARTBEAT', positionMs: 60000, atMs: 60000 },
      { type: 'COMPLETE', positionMs: 90000, atMs: 90000 },
      { type: 'COMPLETE', positionMs: 90000, atMs: 90100 }, // duplicate: still 1 stream
    ],
  });

  // Session S3 (10 days ago): listener2 plays t1 fully — outside the 7d window.
  await seedSession({
    userId: listener2.userId,
    trackId: t1,
    createdAt: daysAgo(10),
    events: [
      { type: 'START', positionMs: 0, atMs: 0 },
      { type: 'HEARTBEAT', positionMs: 30000, atMs: 30000 },
      { type: 'COMPLETE', positionMs: 60000, atMs: 60000 },
    ],
  });

  // Session S4 (1 day ago): failed play of t1 — error after 45s of listening.
  await seedSession({
    userId: listener.userId,
    trackId: t1,
    createdAt: daysAgo(1),
    events: [
      { type: 'START', positionMs: 0, atMs: 0 },
      { type: 'HEARTBEAT', positionMs: 30000, atMs: 30000 },
      { type: 'ERROR', positionMs: 45000, atMs: 45000 },
    ],
  });

  // Session S5 (1 day ago): abandoned play of t2 — START only.
  await seedSession({
    userId: listener2.userId,
    trackId: t2,
    createdAt: daysAgo(1, 30_000),
    events: [{ type: 'START', positionMs: 0, atMs: 0 }],
  });

  // Session S6 (3 days ago): forward seek on t0 — 0 -> 60000 jump is capped at 35000.
  await seedSession({
    userId: listener2.userId,
    trackId: t0,
    createdAt: daysAgo(3),
    events: [
      { type: 'START', positionMs: 0, atMs: 0 },
      { type: 'HEARTBEAT', positionMs: 60000, atMs: 30000 }, // +35000 (capped)
      { type: 'HEARTBEAT', positionMs: 30000, atMs: 60000 }, // backward seek: +0
      { type: 'COMPLETE', positionMs: 90000, atMs: 90000 }, // +35000 (capped)
    ],
  });

  // Session S7 (100 days ago): old completed play of t0 — only in "all".
  await seedSession({
    userId: listener.userId,
    trackId: t0,
    createdAt: daysAgo(100),
    events: [
      { type: 'START', positionMs: 0, atMs: 0 },
      { type: 'COMPLETE', positionMs: 120000, atMs: 120000 }, // +35000 (capped)
    ],
  });

  // Session S8 (2 days ago): a2's track played — must never leak into a1.
  await seedSession({
    userId: listener.userId,
    trackId: a2.trackIds[0],
    createdAt: daysAgo(2, 120_000),
    events: [
      { type: 'START', positionMs: 0, atMs: 0 },
      { type: 'COMPLETE', positionMs: 60000, atMs: 60000 },
    ],
  });
}, 120_000);

afterAll(async () => {
  // Scoped cleanup: only rows created by this suite.
  await prisma.playEvent.deleteMany({ where: { user: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.playbackSession.deleteMany({
    where: { user: { email: { endsWith: TEST_DOMAIN } } },
  });
  await prisma.track.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.album.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.refreshToken.deleteMany({ where: { user: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
  await app.close();
});

const overviewUrl = (artistId: string, qs = 'range=all') =>
  `/v1/artists/${artistId}/analytics/overview?${qs}`;

describe('ownership isolation', () => {
  it('excludes other artists’ plays from totals', async () => {
    const res = await app.inject({
      method: 'GET',
      url: overviewUrl(a1.artistId),
      headers: auth(a1.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // a1 sessions: S1..S7 (7 sessions). S8 belongs to a2 and must not leak.
    expect(body.starts).toBe(7);
    // S1, S2, S3, S6, S7 completed = 5 streams
    expect(body.streams).toBe(5);
  });

  it('returns 403 when an artist requests another artist’s analytics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: overviewUrl(a2.artistId),
      headers: auth(a1.token),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown artist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: overviewUrl(randomUUID()),
      headers: auth(a1.token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('date-range filtering', () => {
  it('7d excludes sessions older than 7 days', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, 'range=7d'),
        headers: auth(a1.token),
      })
    ).json();
    // S1, S2, S4, S5, S6 in range (S3 at 10d and S7 at 100d excluded)
    expect(body.starts).toBe(5);
    expect(body.streams).toBe(3); // S1, S2, S6
    expect(body.uniqueListeners).toBe(2);
  });

  it('28d includes the 10-day-old session but not the 100-day-old one', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, 'range=28d'),
        headers: auth(a1.token),
      })
    ).json();
    expect(body.starts).toBe(6);
    expect(body.streams).toBe(4); // +S3
  });

  it('90d still excludes the 100-day-old session', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, 'range=90d'),
        headers: auth(a1.token),
      })
    ).json();
    expect(body.starts).toBe(6);
  });

  it('all includes every session', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, 'range=all'),
        headers: auth(a1.token),
      })
    ).json();
    expect(body.starts).toBe(7);
    expect(body.streams).toBe(5);
    expect(body.from).toBeNull();
  });

  it('rejects an unknown range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: overviewUrl(a1.artistId, 'range=30d'),
      headers: auth(a1.token),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('stream counting and playback outcomes', () => {
  it('counts completed/failed/incomplete distinctly in the 7d window', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, 'range=7d'),
        headers: auth(a1.token),
      })
    ).json();
    expect(body.streams).toBe(3); // S1, S2, S6
    expect(body.starts).toBe(5); // S1, S2, S4, S5, S6
    expect(body.failedPlays).toBe(1); // S4
    expect(body.incompletePlays).toBe(1); // S5
  });

  it('never counts a failed session as a stream', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${a1.artistId}/analytics/tracks?range=7d&trackId=${a1.trackIds[1]}`,
        headers: auth(a1.token),
      })
    ).json();
    // t1 in 7d: S4 only (failed). S3 is 10d old.
    expect(body.data).toHaveLength(1);
    expect(body.data[0].streams).toBe(0);
    expect(body.data[0].failedPlays).toBe(1);
  });
});

describe('unique listeners', () => {
  it('counts a listener once however many sessions they start', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, 'range=7d'),
        headers: auth(a1.token),
      })
    ).json();
    // listener: S1, S2, S4 (3 sessions) -> 1; listener2: S5, S6 (2 sessions) -> 1
    expect(body.uniqueListeners).toBe(2);
  });
});

describe('listening time', () => {
  it('sums heartbeat deltas with the 35s seek cap', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, 'range=7d'),
        headers: auth(a1.token),
      })
    ).json();
    // S1: 30000+30000+30000 = 90000
    // S2: 30000+0(dup)+30000+30000+0(dup COMPLETE) = 90000
    // S4: 30000+15000 (time before the error still counts) = 45000
    // S5: START only = 0
    // S6: 35000 (capped fwd seek) + 0 (backwd) + 35000 (capped) = 70000
    expect(body.listeningTimeMs).toBe(90000 + 90000 + 45000 + 0 + 70000);
  });

  it('attributes listening time per track', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${a1.artistId}/analytics/tracks?range=7d`,
        headers: auth(a1.token),
      })
    ).json();
    const byId = Object.fromEntries(
      body.data.map((t: { trackId: string; listeningTimeMs: number }) => [
        t.trackId,
        t.listeningTimeMs,
      ]),
    );
    expect(byId[a1.trackIds[0]]).toBe(90000 + 90000 + 70000); // S1+S2+S6
    expect(byId[a1.trackIds[1]]).toBe(45000); // S4
    expect(byId[a1.trackIds[2]]).toBe(0); // S5
  });
});

describe('track and album filtering', () => {
  it('filters the overview by track', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, `range=all&trackId=${a1.trackIds[0]}`),
        headers: auth(a1.token),
      })
    ).json();
    // t0: S1, S2, S6, S7 -> 4 streams, 2 listeners (listener x3, listener2 x1)
    expect(body.streams).toBe(4);
    expect(body.starts).toBe(4);
    expect(body.uniqueListeners).toBe(2);
  });

  it('filters the overview by album', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(a1.artistId, `range=all&albumId=${a1.albumId}`),
        headers: auth(a1.token),
      })
    ).json();
    // album0 holds t0 and t2 (round-robin over 3 tracks / 2 albums)
    expect(body.streams).toBe(4); // t0's 4 streams; t2 (S5) incomplete
    expect(body.starts).toBe(5);
  });

  it('returns 404 for a trackId that is not the artist’s', async () => {
    const res = await app.inject({
      method: 'GET',
      url: overviewUrl(a1.artistId, `range=all&trackId=${a2.trackIds[0]}`),
      headers: auth(a1.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an albumId that is not the artist’s', async () => {
    const res = await app.inject({
      method: 'GET',
      url: overviewUrl(a1.artistId, `range=all&albumId=${a2.albumId}`),
      headers: auth(a1.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('ranks tracks by streams desc with pagination', async () => {
    const page1 = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${a1.artistId}/analytics/tracks?range=all&limit=2&page=1`,
        headers: auth(a1.token),
      })
    ).json();
    expect(page1.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(page1.data).toHaveLength(2);
    // t0 has 4 streams — must rank first
    expect(page1.data[0].trackId).toBe(a1.trackIds[0]);
    expect(page1.data[0].streams).toBe(4);

    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${a1.artistId}/analytics/tracks?range=all&limit=2&page=2`,
        headers: auth(a1.token),
      })
    ).json();
    expect(page2.data).toHaveLength(1);
    expect(page2.pagination.page).toBe(2);
  });

  it('rolls plays up to albums', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${a1.artistId}/analytics/albums?range=all`,
        headers: auth(a1.token),
      })
    ).json();
    expect(body.pagination.total).toBe(2);
    // album0 (t0+t2): 4 streams; album1 (t1): S3 completed + S4 failed = 1 stream
    const byId = Object.fromEntries(
      body.data.map((a: { albumId: string; streams: number }) => [a.albumId, a.streams]),
    );
    expect(byId[a1.albumId]).toBe(4);
    expect(body.data[0].albumId).toBe(a1.albumId); // ranked first
  });
});

describe('trend', () => {
  it('buckets plays by UTC day', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${a1.artistId}/analytics/trend?range=7d&granularity=day`,
        headers: auth(a1.token),
      })
    ).json();
    expect(body.granularity).toBe('day');
    const byDate = Object.fromEntries(
      body.points.map((p: { date: string; streams: number }) => [p.date, p.streams]),
    );
    const d1 = daysAgo(1).toISOString().slice(0, 10);
    const d2 = daysAgo(2).toISOString().slice(0, 10);
    const d3 = daysAgo(3).toISOString().slice(0, 10);
    // S4(failed)+S5(incomplete) on d1 -> 0 streams; S1+S2 on d2 -> 2; S6 on d3 -> 1
    expect(byDate[d1]).toBe(0);
    expect(byDate[d2]).toBe(2);
    expect(byDate[d3]).toBe(1);
    // buckets are ascending
    const dates = body.points.map((p: { date: string }) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it('supports weekly buckets', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${a1.artistId}/analytics/trend?range=28d&granularity=week`,
        headers: auth(a1.token),
      })
    ).json();
    expect(body.granularity).toBe('week');
    const total = body.points.reduce((n: number, p: { streams: number }) => n + p.streams, 0);
    expect(total).toBe(4); // S1, S2, S3, S6
  });
});

describe('recent activity', () => {
  it('returns the latest completed streams without listener identity', async () => {
    const body = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${a1.artistId}/analytics/recent?range=all&limit=3`,
        headers: auth(a1.token),
      })
    ).json();
    expect(body.data).toHaveLength(3);
    // Most recent completed first: S4 failed and S5 incomplete are excluded.
    // Order: S6 (3d)? No — S1/S2 (2d) are more recent than S6 (3d).
    const playedAts = body.data.map((r: { playedAt: string }) => r.playedAt);
    expect([...playedAts].sort().reverse()).toEqual(playedAts);
    for (const row of body.data) {
      expect(row).not.toHaveProperty('userId');
      expect(row).not.toHaveProperty('user');
      expect(typeof row.trackTitle).toBe('string');
      expect(typeof row.listeningTimeMs).toBe('number');
    }
  });
});

describe('empty datasets', () => {
  it('returns zeros and empty lists for an artist with no plays', async () => {
    const overview = (
      await app.inject({
        method: 'GET',
        url: overviewUrl(emptyArtist.artistId),
        headers: auth(emptyArtist.token),
      })
    ).json();
    expect(overview).toMatchObject({
      streams: 0,
      starts: 0,
      failedPlays: 0,
      incompletePlays: 0,
      uniqueListeners: 0,
      listeningTimeMs: 0,
    });
    const tracks = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${emptyArtist.artistId}/analytics/tracks?range=all`,
        headers: auth(emptyArtist.token),
      })
    ).json();
    expect(tracks.data).toEqual([]);
    expect(tracks.pagination.total).toBe(0);
    const trend = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${emptyArtist.artistId}/analytics/trend?range=7d`,
        headers: auth(emptyArtist.token),
      })
    ).json();
    expect(trend.points).toEqual([]);
    const recent = (
      await app.inject({
        method: 'GET',
        url: `/v1/artists/${emptyArtist.artistId}/analytics/recent?range=all`,
        headers: auth(emptyArtist.token),
      })
    ).json();
    expect(recent.data).toEqual([]);
  });
});

describe('authorization', () => {
  // Fixtures are assigned in the top-level beforeAll, so build URLs lazily.
  const urls = () => [
    overviewUrl(a1.artistId),
    `/v1/artists/${a1.artistId}/analytics/tracks?range=7d`,
    `/v1/artists/${a1.artistId}/analytics/albums?range=7d`,
    `/v1/artists/${a1.artistId}/analytics/trend?range=7d`,
    `/v1/artists/${a1.artistId}/analytics/recent?range=7d`,
  ];

  it('denies LISTENER on every analytics endpoint', async () => {
    for (const url of urls()) {
      const res = await app.inject({ method: 'GET', url, headers: auth(listener.token) });
      expect(res.statusCode).toBe(403);
    }
  });

  it('denies unauthenticated callers on every analytics endpoint', async () => {
    for (const url of urls()) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });

  it('lets ADMIN view any artist’s analytics', async () => {
    const res = await app.inject({
      method: 'GET',
      url: overviewUrl(a1.artistId),
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().streams).toBe(5);
  });

  it('denies LISTENER the platform overview but allows ADMIN', async () => {
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/analytics/platform/overview?range=all',
      headers: auth(listener.token),
    });
    expect(denied.statusCode).toBe(403);

    const anon = await app.inject({
      method: 'GET',
      url: '/v1/analytics/platform/overview?range=all',
    });
    expect(anon.statusCode).toBe(401);

    const allowed = await app.inject({
      method: 'GET',
      url: '/v1/analytics/platform/overview?range=all',
      headers: auth(admin.token),
    });
    expect(allowed.statusCode).toBe(200);
    const body = allowed.json();
    expect(body.artistId).toBeNull();
    // Platform = a1 (5 streams) + a2 (S8: 1 stream)
    expect(body.streams).toBe(6);
  });

  it('denies ARTIST the platform overview', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/analytics/platform/overview?range=all',
      headers: auth(a1.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('heartbeat determinism', () => {
  it('produces identical totals on repeated reads', async () => {
    const url = overviewUrl(a1.artistId, 'range=7d');
    const first = (await app.inject({ method: 'GET', url, headers: auth(a1.token) })).json();
    const second = (await app.inject({ method: 'GET', url, headers: auth(a1.token) })).json();
    expect(second.streams).toBe(first.streams);
    expect(second.listeningTimeMs).toBe(first.listeningTimeMs);
    expect(second.uniqueListeners).toBe(first.uniqueListeners);
  });
});
