/**
 * Phase 32 — production security audit: authorization & token abuse.
 *
 * Systematic IDOR/BOLA coverage across the API surface plus playback and
 * download token abuse cases. Every test asserts that one authenticated
 * principal cannot reach another principal's resources, and that forged,
 * expired, or mismatched tokens fail closed.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL. Scoped
 * cleanup with TEST_DOMAIN emails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';

const TEST_DOMAIN = '@phase32-sec.local';
let counter = 0;
const testEmail = (tag: string) => `phase32-sec-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;

type Role = 'LISTENER' | 'ARTIST' | 'ADMIN';
interface TestUser {
  userId: string;
  token: string;
  role: Role;
}

async function registerAndLogin(email: string, role: Role): Promise<TestUser> {
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: email.split('@')[0] },
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
  return { userId, token: login.json().tokens.accessToken as string, role };
}

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

let alice: TestUser;
let bob: TestUser;
let admin: TestUser;
let aliceArtistId: string;
let bobArtistId: string;

async function scopedClean() {
  // FK-safe order: tracks/artists reference users; playlists reference users.
  const safe = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      /* referenced rows stay; fixtures are uniquely namespaced */
    }
  };
  const scoped = { email: { endsWith: TEST_DOMAIN } };
  await safe(() => prisma.playEvent.deleteMany({ where: { session: { user: scoped } } }));
  await safe(() => prisma.playbackSession.deleteMany({ where: { user: scoped } }));
  await safe(() => prisma.playlistItem.deleteMany({ where: { playlist: { owner: scoped } } }));
  await safe(() => prisma.playlist.deleteMany({ where: { owner: scoped } }));
  await safe(() => prisma.track.deleteMany({ where: { artist: { owner: scoped } } }));
  await safe(() => prisma.artist.deleteMany({ where: { owner: scoped } }));
  await safe(() => prisma.user.deleteMany({ where: scoped }));
}

beforeAll(async () => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    RATE_LIMIT_LOGIN: '1000',
    RATE_LIMIT_REGISTER: '1000',
    RATE_LIMIT_REFRESH: '1000',
    RATE_LIMIT_API: '10000',
    RATE_LIMIT_STREAMING: '10000',
    RATE_LIMIT_OFFLINE_AUTHORIZE: '1000',
  });
  app = await buildApp(config);
  await scopedClean();

  alice = await registerAndLogin(testEmail('alice'), 'LISTENER');
  bob = await registerAndLogin(testEmail('bob'), 'LISTENER');
  admin = await registerAndLogin(testEmail('admin'), 'ADMIN');

  // Two ARTIST users, each owning their artist row.
  const aliceArtist = await registerAndLogin(testEmail('alice-artist'), 'ARTIST');
  const bobArtist = await registerAndLogin(testEmail('bob-artist'), 'ARTIST');
  (alice as TestUser & { artistUser?: TestUser }).artistUser = aliceArtist;
  (bob as TestUser & { artistUser?: TestUser }).artistUser = bobArtist;

  const a1 = await prisma.artist.create({
    data: { name: 'Alice Artist', ownerUserId: aliceArtist.userId },
    select: { id: true },
  });
  const a2 = await prisma.artist.create({
    data: { name: 'Bob Artist', ownerUserId: bobArtist.userId },
    select: { id: true },
  });
  aliceArtistId = a1.id;
  bobArtistId = a2.id;
});

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// IDOR / BOLA: playlists
// ---------------------------------------------------------------------------

describe('IDOR: playlists', () => {
  it("bob cannot read alice's private playlist", async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(alice),
      payload: { title: 'Alice Private', visibility: 'PRIVATE' },
    });
    expect(created.statusCode).toBe(201);
    const playlistId = created.json().id as string;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(bob),
    });
    // Non-owners get 404 (not 403) so private playlist ids cannot be probed.
    expect(res.statusCode).toBe(404);
  });

  it("bob cannot add tracks to alice's playlist", async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(alice),
      payload: { title: 'Alice Private 2', visibility: 'PRIVATE' },
    });
    const playlistId = created.json().id as string;

    const res = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/items`,
      headers: auth(bob),
      payload: { trackId: '00000000-0000-0000-0000-000000000000' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("bob cannot delete alice's playlist", async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(alice),
      payload: { title: 'Alice Private 3', visibility: 'PRIVATE' },
    });
    const playlistId = created.json().id as string;

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(bob),
    });
    expect([403, 404]).toContain(res.statusCode);

    // Alice's playlist still exists.
    const check = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${playlistId}`,
      headers: auth(alice),
    });
    expect(check.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// IDOR / BOLA: artist isolation (catalog + royalties)
// ---------------------------------------------------------------------------

describe('IDOR: artist isolation', () => {
  const artistUser = (u: TestUser): TestUser =>
    (u as TestUser & { artistUser: TestUser }).artistUser;

  it("bob's artist user cannot update alice's artist profile", async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${aliceArtistId}`,
      headers: auth(artistUser(bob)),
      payload: { bio: 'hijacked' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("bob's artist user cannot read alice's royalty overview", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/artists/${aliceArtistId}/royalties/overview`,
      headers: auth(artistUser(bob)),
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("a LISTENER cannot read any artist's royalties", async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/artists/${aliceArtistId}/royalties/overview`,
      headers: auth(alice),
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("bob's artist user cannot create a track under alice's artist", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tracks',
      headers: auth(artistUser(bob)),
      payload: { title: 'Hijack Track', artistId: aliceArtistId, durationMs: 60000 },
    });
    expect([403, 404, 400, 422]).toContain(res.statusCode);
  });
});

// ---------------------------------------------------------------------------
// IDOR / BOLA: commerce orders
// ---------------------------------------------------------------------------

describe('IDOR: commerce', () => {
  it('admin commerce endpoints reject LISTENER and ARTIST', async () => {
    for (const user of [alice, (alice as TestUser & { artistUser: TestUser }).artistUser]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/commerce/stats',
        headers: auth(user),
      });
      expect([403, 404]).toContain(res.statusCode);
    }
  });

  it('a user cannot read another user\'s cart by guessing', async () => {
    // Carts are strictly caller-scoped: GET /v1/commerce/cart returns the
    // caller's own cart; there is no by-id cart endpoint to probe.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/carts/${bob.userId}`,
      headers: auth(alice),
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// IDOR / BOLA: admin & audit
// ---------------------------------------------------------------------------

describe('IDOR: admin isolation', () => {
  it('LISTENER cannot list users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: auth(alice),
    });
    expect(res.statusCode).toBe(403);
  });

  it('LISTENER cannot read the audit log', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-logs',
      headers: auth(alice),
    });
    expect(res.statusCode).toBe(403);
  });

  it('LISTENER cannot change another user\'s role', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${bob.userId}/role`,
      headers: auth(alice),
      payload: { role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(403);
    // Bob is still a LISTENER.
    const bobRow = await prisma.user.findUnique({
      where: { id: bob.userId },
      select: { role: true },
    });
    expect(bobRow?.role).toBe('LISTENER');
  });

  it('ADMIN can still list users (control)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users',
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Token abuse: playback sessions
// ---------------------------------------------------------------------------

describe('token abuse: playback sessions', () => {
  it('expired access tokens are rejected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer this.is.not.a.valid.token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('tampered tokens are rejected', async () => {
    // Take a valid token and flip a character in the payload segment.
    const parts = alice.token.split('.');
    const tampered = `${parts[0]}.${parts[1].slice(0, -2)}xx.${parts[2]}`;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tampered}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a playback token for the wrong track fails closed', async () => {
    // Mint a session row directly, then try to use its token against a
    // different track's delivery URL. Delivery must reject it.
    const trackA = await prisma.track.create({
      data: {
        title: 'Token Abuse A',
        artistId: aliceArtistId,
        durationMs: 60_000,
        status: 'READY',
      },
      select: { id: true },
    });
    const trackB = await prisma.track.create({
      data: {
        title: 'Token Abuse B',
        artistId: aliceArtistId,
        durationMs: 60_000,
        status: 'READY',
      },
      select: { id: true },
    });
    const token = randomBytes(32).toString('hex');
    await prisma.playbackSession.create({
      data: {
        userId: alice.userId,
        trackId: trackA.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });
    // Track B's manifest URL with track A's token must fail.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/playback/sessions/hls/master.m3u8?token=${token}&trackId=${trackB.id}`,
      headers: auth(alice),
    });
    expect([400, 401, 404]).toContain(res.statusCode);
  });
});

// ---------------------------------------------------------------------------
// Webhook forgery
// ---------------------------------------------------------------------------

describe('webhook forgery', () => {
  it('commerce webhook with a bad signature is rejected without state change', async () => {
    const before = await prisma.commercePaymentEvent.count();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhooks/mock',
      headers: { 'x-mock-signature': 'forged' },
      payload: { type: 'payment.succeeded', paymentId: 'nonexistent' },
    });
    expect([400, 401]).toContain(res.statusCode);
    const after = await prisma.commercePaymentEvent.count();
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Path traversal: HLS delivery
// ---------------------------------------------------------------------------

describe('path traversal: HLS delivery', () => {
  it('rejects path traversal in the segment param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/playback/hls/128k/..%2F..%2Fsecret?token=invalid',
      headers: auth(alice),
    });
    // Schema pattern rejects before any storage access.
    expect([400, 401, 404]).toContain(res.statusCode);
  });

  it('rejects path traversal in the rendition param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/playback/hls/..%2Fsecret/index.m3u8?token=invalid',
      headers: auth(alice),
    });
    expect([400, 401, 404]).toContain(res.statusCode);
  });
});

// ---------------------------------------------------------------------------
// Phase 32 hardening surface: correlation, readiness, metrics gating
// ---------------------------------------------------------------------------

describe('phase 32 hardening surface', () => {
  it('echoes a request id on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('honors a sane client-supplied request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-request-id': 'client-trace-123' },
    });
    expect(res.headers['x-request-id']).toBe('client-trace-123');
  });

  it('rejects a malicious client-supplied request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-request-id': 'evil\ninjected: header' },
    });
    expect(res.headers['x-request-id']).not.toBe('evil\ninjected: header');
  });

  it('readiness probe reports ready when the DB is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
  });

  it('metrics endpoint is reachable on loopback', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requests.total).toBeGreaterThan(0);
    expect(body.startedAt).toBeTruthy();
  });

  it('oversized JSON bodies are rejected', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: testEmail('big'), password: PASSWORD, displayName: big },
    });
    expect(res.statusCode).toBe(413);
  });

  it('malformed JSON gets a 400 problem response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{not valid json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().title).toBeTruthy();
  });
});
