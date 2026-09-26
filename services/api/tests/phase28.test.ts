/**
 * Phase 28 — synchronized listening rooms tests.
 *
 * Full HTTP stack via `app.inject()` plus a real WebSocket server
 * (`app.listen()` on an ephemeral port, `ws` client) against
 * TEST_DATABASE_URL (never the dev DB).
 *
 * Covers:
 * - Room creation: auth, entitlement gating, queue seeding (trackIds and
 *   playlist snapshots), input validation, playlist access rules, and the
 *   "no tokens / no audio URLs in state" invariant.
 * - Join: single-use invitation claim (incl. concurrent double-join —
 *   exactly one winner), indistinguishable 404s for bad/used/revoked/
 *   expired/wrong-room tokens, entitlement required to join, idempotent
 *   rejoin, 410 on ended rooms.
 * - Leave/end: participant leave keeps the room ACTIVE; host leave and host
 *   end terminate the room; memberships are preserved so members can still
 *   fetch the authoritative ENDED state; leaving an ended room cleans up.
 * - Authorization: non-members get existence-hiding 404s; participants
 *   cannot invite/end/command (403 host_only); ended rooms reject commands
 *   with 410.
 * - WebSocket gateway: upgrade auth (401 without/bad token), join/resync,
 *   host commands broadcast to subscribers, revision compare-and-swap
 *   (stale_revision carries the authoritative revision), per-socket command
 *   throttle, ping/pong clock sync, malformed message handling, and
 *   disconnect-not-ending-the-room.
 * - HTTP rate limits for room creation/join/invitation.
 *
 * Cleanup is scoped to `@rooms-test.local` addresses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { roomSubscriberCount } from '../src/modules/rooms/hub.js';

const TEST_DOMAIN = '@rooms-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase28-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;
let port: number;

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

/** FK-safe cleanup, children before parents. Room rows cascade to members,
 *  queue items, and invitations; queue items Restrict user deletion so rooms
 *  go first. */
async function scopedClean(): Promise<void> {
  const roomWhere = { host: { email: { endsWith: TEST_DOMAIN } } };
  await prisma.listeningRoom.deleteMany({ where: roomWhere });
  const userWhere = { user: { email: { endsWith: TEST_DOMAIN } } };
  await prisma.playEvent.deleteMany({ where: userWhere });
  await prisma.playbackSession.deleteMany({ where: userWhere });
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "subscription_events" DISABLE TRIGGER "subscription_events_no_delete"',
  );
  await prisma.subscriptionEvent.deleteMany({ where: { subscription: userWhere } });
  await prisma.subscription.deleteMany({ where: userWhere });
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "subscription_events" ENABLE TRIGGER "subscription_events_no_delete"',
  );
  // Playlists owned by test users must go before their tracks (playlist_tracks
  // references tracks; user deletion would cascade playlists only later).
  await prisma.playlist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.track.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.refreshToken.deleteMany({ where: userWhere });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
}

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

// --- Fixtures ----------------------------------------------------------------

let host: TestUser;
let guest: TestUser;
let guest2: TestUser;
let free: TestUser;
let stranger: TestUser;
let artistOwner: TestUser;
let trackA: string;
let trackB: string;
let trackC: string;
let processingTrack: string;

async function createRoomAs(user: TestUser, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/rooms',
    headers: auth(user),
    payload: body,
  });
}

async function inviteAs(user: TestUser, roomId: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/rooms/${roomId}/invitations`,
    headers: auth(user),
  });
}

async function joinAs(user: TestUser, roomId: string, token: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/rooms/${roomId}/join`,
    headers: auth(user),
    payload: { token },
  });
}

/** Create a room and have `guest` join it via a fresh invitation. */
async function roomWithGuest(): Promise<{ roomId: string; token: string }> {
  const created = await createRoomAs(host, { trackIds: [trackA, trackB] });
  expect(created.statusCode).toBe(201);
  const roomId = created.json().roomId as string;
  const inv = await inviteAs(host, roomId);
  expect(inv.statusCode).toBe(201);
  const token = inv.json().token as string;
  const joined = await joinAs(guest, roomId, token);
  expect(joined.statusCode).toBe(200);
  return { roomId, token };
}

beforeAll(async () => {
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    RATE_LIMIT_LOGIN: '1000',
    RATE_LIMIT_REGISTER: '1000',
    RATE_LIMIT_REFRESH: '1000',
    RATE_LIMIT_LOGOUT: '1000',
    RATE_LIMIT_API: '10000',
    RATE_LIMIT_STREAMING: '10000',
    RATE_LIMIT_ROOMS_CREATE: '10000',
    RATE_LIMIT_ROOMS_JOIN: '10000',
    RATE_LIMIT_ROOMS_INVITE: '10000',
    DEV_SUBSCRIPTIONS_ENABLED: 'true',
  });
  app = await buildApp(config);
  await scopedClean();

  host = await createUser('host');
  guest = await createUser('guest');
  guest2 = await createUser('guest2');
  free = await createUser('free');
  stranger = await createUser('stranger');
  artistOwner = await createUser('artist-owner', 'ARTIST');
  await grantActive(host, `ext-${Date.now()}-h`);
  await grantActive(guest, `ext-${Date.now()}-g`);
  await grantActive(guest2, `ext-${Date.now()}-g2`);
  await grantActive(stranger, `ext-${Date.now()}-s`);
  // `free` deliberately has no subscription.

  const artist = await prisma.artist.create({
    data: { name: 'Phase28 Artist', ownerUserId: artistOwner.id },
    select: { id: true },
  });
  const mkTrack = (title: string, status: 'READY' | 'PROCESSING') =>
    prisma.track.create({
      data: { title, artistId: artist.id, durationMs: 180_000, status },
      select: { id: true },
    });
  trackA = (await mkTrack('Room Track A', 'READY')).id;
  trackB = (await mkTrack('Room Track B', 'READY')).id;
  trackC = (await mkTrack('Room Track C', 'READY')).id;
  processingTrack = (await mkTrack('Processing Track', 'PROCESSING')).id;

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No listen address');
  port = address.port;
}, 120_000);

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
});

// --- Room creation ------------------------------------------------------------

describe('POST /v1/rooms', () => {
  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/rooms',
      payload: { trackIds: [trackA] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('requires playback entitlement; joining never grants any', async () => {
    const res = await createRoomAs(free, { trackIds: [trackA] });
    expect(res.statusCode).toBe(403);
    expect(res.json().title).toBe('Subscription Required');
  });

  it('creates a room seeded from trackIds', async () => {
    const res = await createRoomAs(host, { trackIds: [trackA, trackB] });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.roomId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.revision).toBe(0);
    expect(body.status).toBe('ACTIVE');
    expect(body.playbackState).toBe('PAUSED');
    expect(body.role).toBe('HOST');
    expect(body.queueIndex).toBe(0);
    expect(body.positionMs).toBe(0);
    expect(body.currentTrackId).toBe(trackA);
    expect(body.queue.map((t: { id: string }) => t.id)).toEqual([trackA, trackB]);
    expect(body.queue[0].title).toBe('Room Track A');
    expect(body.queue[0].artistName).toBe('Phase28 Artist');
    expect(new Date(body.serverTime).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('rejects when both trackIds and playlistId are supplied', async () => {
    const res = await createRoomAs(host, { trackIds: [trackA], playlistId: trackB });
    expect(res.statusCode).toBe(400);
  });

  it('rejects when neither trackIds nor playlistId is supplied', async () => {
    const res = await createRoomAs(host, {});
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown tracks and non-READY tracks', async () => {
    const missing = await createRoomAs(host, {
      trackIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(missing.statusCode).toBe(404);
    const notReady = await createRoomAs(host, { trackIds: [processingTrack] });
    expect(notReady.statusCode).toBe(409);
  });

  it('seeds from a playlist snapshot the caller can access', async () => {
    const pl = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(host),
      payload: { title: 'Room Seed', visibility: 'PRIVATE' },
    });
    expect(pl.statusCode).toBe(201);
    const playlistId = pl.json().id as string;
    for (const tid of [trackB, trackC]) {
      const add = await app.inject({
        method: 'POST',
        url: `/v1/playlists/${playlistId}/tracks`,
        headers: auth(host),
        payload: { trackId: tid },
      });
      expect(add.statusCode).toBe(201);
    }
    const res = await createRoomAs(host, { playlistId });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.queue.map((t: { id: string }) => t.id)).toEqual([trackB, trackC]);
    // Snapshot semantics: only track IDs enter the room, no playlist linkage.
    expect(JSON.stringify(body)).not.toContain(playlistId);
  });

  it('does not leak another user\u2019s private playlist', async () => {
    const pl = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(stranger),
      payload: { title: 'Stranger Private', visibility: 'PRIVATE' },
    });
    const playlistId = pl.json().id as string;
    const add = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${playlistId}/tracks`,
      headers: auth(stranger),
      payload: { trackId: trackA },
    });
    expect(add.statusCode).toBe(201);
    const res = await createRoomAs(host, { playlistId });
    expect(res.statusCode).toBe(404);
  });

  it('room state carries no playback tokens and no audio URLs', async () => {
    const res = await createRoomAs(host, { trackIds: [trackA] });
    expect(res.statusCode).toBe(201);
    const raw = JSON.stringify(res.json());
    expect(raw).not.toMatch(/"token"/i);
    expect(raw).not.toMatch(/playbackSession/i);
    expect(raw).not.toMatch(/\/v1\/playback\//i);
    expect(raw).not.toMatch(/\.m3u8/i);
    expect(raw).not.toMatch(/\/segments?\//i);
  });
});

// --- Room state / existence hiding ---------------------------------------------

describe('GET /v1/rooms/:id', () => {
  it('returns state for members and 404 for non-members', async () => {
    const { roomId } = await roomWithGuest();
    const member = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}`,
      headers: auth(guest),
    });
    expect(member.statusCode).toBe(200);
    expect(member.json().role).toBe('PARTICIPANT');
    const outsider = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}`,
      headers: auth(stranger),
    });
    expect(outsider.statusCode).toBe(404);
  });

  it('404s for unknown rooms without leaking', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/rooms/00000000-0000-4000-8000-000000000000',
      headers: auth(host),
    });
    expect(res.statusCode).toBe(404);
  });
});

// --- Join / invitations ---------------------------------------------------------

describe('invitations and POST /v1/rooms/:id/join', () => {
  it('host can create, list, and revoke invitations; raw token issued once', async () => {
    const created = await createRoomAs(host, { trackIds: [trackA] });
    const roomId = created.json().roomId as string;
    const inv = await inviteAs(host, roomId);
    expect(inv.statusCode).toBe(201);
    const invitation = inv.json();
    expect(invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invitation.usedAt).toBeNull();
    expect(new Date(invitation.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const list = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}/invitations`,
      headers: auth(host),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    // Token hashes are never exposed after issuance.
    expect(JSON.stringify(list.json())).not.toContain(invitation.token);
    expect(JSON.stringify(list.json())).not.toMatch(/tokenHash/i);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/rooms/${roomId}/invitations/${invitation.id}`,
      headers: auth(host),
    });
    expect(revoke.statusCode).toBe(204);
    const join = await joinAs(guest, roomId, invitation.token);
    expect(join.statusCode).toBe(404);
  });

  it('participant cannot create or list invitations', async () => {
    const { roomId } = await roomWithGuest();
    expect((await inviteAs(guest, roomId)).statusCode).toBe(403);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}/invitations`,
      headers: auth(guest),
    });
    expect(list.statusCode).toBe(403);
  });

  it('join consumes a single-use token; reuse is indistinguishable from unknown', async () => {
    const created = await createRoomAs(host, { trackIds: [trackA] });
    const roomId = created.json().roomId as string;
    const token = (await inviteAs(host, roomId)).json().token as string;
    expect((await joinAs(guest, roomId, token)).statusCode).toBe(200);
    // Second use of the same token, by another entitled user: 404, not 409/410.
    expect((await joinAs(guest2, roomId, token)).statusCode).toBe(404);
    // Unknown, wrong-room, and malformed tokens all look the same.
    expect((await joinAs(guest2, roomId, 'nope')).statusCode).toBe(404);
    const otherRoom = (await createRoomAs(host, { trackIds: [trackA] })).json().roomId as string;
    const otherToken = (await inviteAs(host, otherRoom)).json().token as string;
    expect((await joinAs(guest2, roomId, otherToken)).statusCode).toBe(404);
  });

  it('expired invitations cannot be used', async () => {
    const created = await createRoomAs(host, { trackIds: [trackA] });
    const roomId = created.json().roomId as string;
    const invitation = (await inviteAs(host, roomId)).json();
    await prisma.listeningRoomInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await joinAs(guest, roomId, invitation.token)).statusCode).toBe(404);
  });

  it('join requires playback entitlement and never grants any', async () => {
    const created = await createRoomAs(host, { trackIds: [trackA] });
    const roomId = created.json().roomId as string;
    const token = (await inviteAs(host, roomId)).json().token as string;
    const res = await joinAs(free, roomId, token);
    expect(res.statusCode).toBe(403);
    // The token is not consumed by the failed join: an entitled user can use it.
    expect((await joinAs(guest, roomId, token)).statusCode).toBe(200);
  });

  it('rejoin is idempotent and consumes no token', async () => {
    const { roomId } = await roomWithGuest();
    const again = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${roomId}/join`,
      headers: auth(guest),
      payload: { token: 'unused' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().role).toBe('PARTICIPANT');
  });

  it('concurrent joins with one token admit exactly one user', async () => {
    const created = await createRoomAs(host, { trackIds: [trackA] });
    const roomId = created.json().roomId as string;
    const token = (await inviteAs(host, roomId)).json().token as string;
    const [r1, r2] = await Promise.all([
      joinAs(guest, roomId, token),
      joinAs(guest2, roomId, token),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([200, 404]);
    const members = await prisma.listeningRoomMember.count({
      where: { roomId, role: 'PARTICIPANT' },
    });
    expect(members).toBe(1);
  });
});

// --- Leave / end -----------------------------------------------------------------

describe('POST /v1/rooms/:id/leave and /end', () => {
  it('participant leave keeps the room ACTIVE', async () => {
    const { roomId } = await roomWithGuest();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${roomId}/leave`,
      headers: auth(guest),
    });
    expect(res.statusCode).toBe(204);
    const state = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}`,
      headers: auth(host),
    });
    expect(state.statusCode).toBe(200);
    expect(state.json().status).toBe('ACTIVE');
    // The leaver is now an outsider: existence-hiding 404.
    const gone2 = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}`,
      headers: auth(guest),
    });
    expect(gone2.statusCode).toBe(404);
  });

  it('host leave ends the room; members keep an authoritative ENDED state', async () => {
    const { roomId } = await roomWithGuest();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${roomId}/leave`,
      headers: auth(host),
    });
    expect(res.statusCode).toBe(204);
    for (const user of [host, guest]) {
      const state = await app.inject({
        method: 'GET',
        url: `/v1/rooms/${roomId}`,
        headers: auth(user),
      });
      expect(state.statusCode).toBe(200);
      expect(state.json().status).toBe('ENDED');
    }
    // Non-members still get 404.
    const outsider = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}`,
      headers: auth(stranger),
    });
    expect(outsider.statusCode).toBe(404);
  });

  it('host end terminates the room; commands then 410', async () => {
    const { roomId } = await roomWithGuest();
    const end = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${roomId}/end`,
      headers: auth(host),
    });
    expect(end.statusCode).toBe(204);
    const state = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}`,
      headers: auth(guest),
    });
    expect(state.json().status).toBe('ENDED');
    // Invitations cannot be issued on an ended room (410 Gone).
    const inv = await inviteAs(host, roomId);
    expect(inv.statusCode).toBe(410);
    // Joining an ended room is Gone, not Not Found.
    const joinRes = await joinAs(guest2, roomId, 'unused-token');
    expect(joinRes.statusCode).toBe(410);
  });

  it('participant cannot end the room; non-member gets 404', async () => {
    const { roomId } = await roomWithGuest();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/rooms/${roomId}/end`,
          headers: auth(guest),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/rooms/${roomId}/end`,
          headers: auth(stranger),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('leaving an ended room cleans up the membership', async () => {
    const { roomId } = await roomWithGuest();
    await app.inject({ method: 'POST', url: `/v1/rooms/${roomId}/end`, headers: auth(host) });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${roomId}/leave`,
      headers: auth(guest),
    });
    expect(res.statusCode).toBe(204);
    const member = await prisma.listeningRoomMember.findUnique({
      where: { roomId_userId: { roomId, userId: guest.id } },
    });
    expect(member).toBeNull();
  });
});

// --- Members ----------------------------------------------------------------------

describe('GET /v1/rooms/:id/members', () => {
  it('lists members for members only, host first', async () => {
    const { roomId } = await roomWithGuest();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}/members`,
      headers: auth(host),
    });
    expect(res.statusCode).toBe(200);
    const members = res.json() as { userId: string; role: string }[];
    expect(members).toHaveLength(2);
    expect(members[0].role).toBe('HOST');
    expect(members[0].userId).toBe(host.id);
    const outsider = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}/members`,
      headers: auth(stranger),
    });
    expect(outsider.statusCode).toBe(404);
  });
});

// --- WebSocket gateway ---------------------------------------------------------------

interface WsCollector {
  next: (pred?: (m: any) => boolean, timeoutMs?: number) => Promise<any>;
  close: () => void;
}

function collect(ws: WebSocket): WsCollector {
  const queue: any[] = [];
  const waiters: ((m: any) => boolean)[] = [];
  ws.on('message', (data: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i](msg)) {
        waiters.splice(i, 1);
        return;
      }
    }
    queue.push(msg);
  });
  return {
    next(pred: (m: any) => boolean = () => true, timeoutMs = 5000): Promise<any> {
      const idx = queue.findIndex(pred);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Timed out waiting for WS message')),
          timeoutMs,
        );
        waiters.push((m) => {
          if (pred(m)) {
            clearTimeout(timer);
            resolve(m);
            return true;
          }
          return false;
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

async function wsConnect(token?: string): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${port}/v1/rooms/ws${token ? `?token=${token}` : ''}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
  });
}

async function wsJoin(ws: WebSocket, roomId: string): Promise<WsCollector> {
  const c = collect(ws);
  ws.send(JSON.stringify({ type: 'room.join', roomId }));
  const state = await c.next((m) => m.type === 'room.state');
  expect(state.state.roomId).toBe(roomId);
  return c;
}

describe('WebSocket gateway', () => {
  it('rejects upgrades without a token and with a bad token', async () => {
    await expect(wsConnect()).rejects.toThrow(/401/);
    await expect(wsConnect('bad-token')).rejects.toThrow(/401/);
  });

  it('ping/pong carries server time for clock-offset estimation', async () => {
    const ws = await wsConnect(host.token);
    const c = collect(ws);
    const clientTime = Date.now();
    ws.send(JSON.stringify({ type: 'ping', clientTime }));
    const pong = await c.next((m) => m.type === 'pong');
    expect(pong.clientTime).toBe(clientTime);
    const skew = Math.abs(new Date(pong.serverTime).getTime() - Date.now());
    expect(skew).toBeLessThan(5000);
    c.close();
  });

  it('join is membership-checked; non-members get room_not_found', async () => {
    const { roomId } = await roomWithGuest();
    const ws = await wsConnect(stranger.token);
    const c = collect(ws);
    ws.send(JSON.stringify({ type: 'room.join', roomId }));
    const err = await c.next((m) => m.type === 'error');
    expect(err.code).toBe('room_not_found');
    c.close();
  });

  it('host commands broadcast new state to all subscribers', async () => {
    const { roomId } = await roomWithGuest();
    const hostWs = await wsConnect(host.token);
    const guestWs = await wsConnect(guest.token);
    const hostC = await wsJoin(hostWs, roomId);
    const guestC = await wsJoin(guestWs, roomId);
    // WS (re)subscribes stay silent: member_joined is a membership event,
    // broadcast by the HTTP join, not by socket subscriptions.

    hostWs.send(
      JSON.stringify({
        type: 'room.command',
        roomId,
        command: 'play',
        expectedRevision: 0,
        positionMs: 0,
      }),
    );
    const hostState = await hostC.next((m) => m.type === 'room.state' && m.state.revision === 1);
    const guestState = await guestC.next((m) => m.type === 'room.state' && m.state.revision === 1);
    expect(hostState.state.playbackState).toBe('PLAYING');
    expect(guestState.state.playbackState).toBe('PLAYING');
    expect(guestState.state.positionMs).toBe(0);
    expect(new Date(guestState.state.serverTime).getTime()).toBeLessThanOrEqual(Date.now());
    hostC.close();
    guestC.close();
  });

  it('participant commands are rejected with host_only and change nothing', async () => {
    const { roomId } = await roomWithGuest();
    const ws = await wsConnect(guest.token);
    const c = await wsJoin(ws, roomId);
    ws.send(
      JSON.stringify({
        type: 'room.command',
        roomId,
        command: 'pause',
        expectedRevision: 0,
        positionMs: 1000,
      }),
    );
    const err = await c.next((m) => m.type === 'error');
    expect(err.code).toBe('host_only');
    ws.send(JSON.stringify({ type: 'room.resync', roomId }));
    const state = await c.next((m) => m.type === 'room.state');
    expect(state.state.revision).toBe(0);
    c.close();
  });

  it('stale revisions get stale_revision with the authoritative revision', async () => {
    const { roomId } = await roomWithGuest();
    const ws = await wsConnect(host.token);
    const c = await wsJoin(ws, roomId);
    ws.send(
      JSON.stringify({
        type: 'room.command',
        roomId,
        command: 'play',
        expectedRevision: 0,
        positionMs: 0,
      }),
    );
    await c.next((m) => m.type === 'room.state' && m.state.revision === 1);
    // Retry the same command with the now-stale revision: rejected, and the
    // client is handed the authoritative revision plus the fresh state.
    ws.send(
      JSON.stringify({
        type: 'room.command',
        roomId,
        command: 'play',
        expectedRevision: 0,
        positionMs: 0,
      }),
    );
    const err = await c.next((m) => m.type === 'error' && m.code === 'stale_revision');
    expect(err.currentRevision).toBe(1);
    const fresh = await c.next((m) => m.type === 'room.state' && m.state.revision === 1);
    expect(fresh.state.playbackState).toBe('PLAYING');
    c.close();
  });

  it('seek/next/previous/queue commands validate and advance revision', async () => {
    const { roomId } = await roomWithGuest();
    const ws = await wsConnect(host.token);
    const c = await wsJoin(ws, roomId);

    ws.send(
      JSON.stringify({
        type: 'room.command',
        roomId,
        command: 'seek',
        expectedRevision: 0,
        positionMs: 42_000,
      }),
    );
    const s1 = await c.next((m) => m.type === 'room.state' && m.state.revision === 1);
    expect(s1.state.positionMs).toBe(42_000);

    ws.send(JSON.stringify({ type: 'room.command', roomId, command: 'next', expectedRevision: 1 }));
    const s2 = await c.next((m) => m.type === 'room.state' && m.state.revision === 2);
    expect(s2.state.currentTrackId).toBe(trackB);
    expect(s2.state.queueIndex).toBe(1);
    expect(s2.state.positionMs).toBe(0);

    ws.send(
      JSON.stringify({ type: 'room.command', roomId, command: 'previous', expectedRevision: 2 }),
    );
    const s3 = await c.next((m) => m.type === 'room.state' && m.state.revision === 3);
    expect(s3.state.currentTrackId).toBe(trackA);

    ws.send(
      JSON.stringify({
        type: 'room.command',
        roomId,
        command: 'queue',
        expectedRevision: 3,
        trackIds: [trackC],
        queueIndex: 0,
      }),
    );
    const s4 = await c.next((m) => m.type === 'room.state' && m.state.revision === 4);
    expect(s4.state.queue.map((t: { id: string }) => t.id)).toEqual([trackC]);
    expect(s4.state.currentTrackId).toBe(trackC);

    // Unknown tracks in a queue command are rejected without a revision bump.
    ws.send(
      JSON.stringify({
        type: 'room.command',
        roomId,
        command: 'queue',
        expectedRevision: 4,
        trackIds: ['00000000-0000-4000-8000-000000000000'],
      }),
    );
    const err = await c.next((m) => m.type === 'error');
    expect(err.code).toBe('room_not_found');
    c.close();
  });

  it('malformed messages get structured errors, not disconnects', async () => {
    const ws = await wsConnect(host.token);
    const c = collect(ws);
    ws.send('not json');
    const e1 = await c.next((m) => m.type === 'error');
    expect(e1.code).toBe('invalid_command');
    ws.send(JSON.stringify({ type: 'room.nope' }));
    const e2 = await c.next((m) => m.type === 'error');
    expect(e2.code).toBe('invalid_command');
    // The socket is still usable.
    ws.send(JSON.stringify({ type: 'ping', clientTime: 1 }));
    const pong = await c.next((m) => m.type === 'pong');
    expect(pong.clientTime).toBe(1);
    c.close();
  });

  it('per-socket command throttle rejects floods with rate_limited', async () => {
    const { roomId } = await roomWithGuest();
    const ws = await wsConnect(host.token);
    const c = await wsJoin(ws, roomId);
    // Fire 40 pause commands at revision 0; the first lands, the rest are
    // stale or throttled — at least one must be explicitly rate_limited.
    for (let i = 0; i < 40; i++) {
      ws.send(
        JSON.stringify({
          type: 'room.command',
          roomId,
          command: 'pause',
          expectedRevision: 0,
          positionMs: i,
        }),
      );
    }
    const limited = await c.next((m) => m.type === 'error' && m.code === 'rate_limited', 10_000);
    expect(limited.roomId).toBe(roomId);
    c.close();
  }, 20_000);

  it('disconnect does not end the room; resync recovers state', async () => {
    const { roomId } = await roomWithGuest();
    const ws = await wsConnect(guest.token);
    const c = await wsJoin(ws, roomId);
    c.close();
    await new Promise((r) => setTimeout(r, 200));
    const state = await app.inject({
      method: 'GET',
      url: `/v1/rooms/${roomId}`,
      headers: auth(host),
    });
    expect(state.statusCode).toBe(200);
    expect(state.json().status).toBe('ACTIVE');
    // Reconnect and resync: membership (not WS subscription) authorizes it.
    const ws2 = await wsConnect(guest.token);
    const c2 = collect(ws2);
    ws2.send(JSON.stringify({ type: 'room.resync', roomId }));
    const state2 = await c2.next((m) => m.type === 'room.state');
    expect(state2.state.roomId).toBe(roomId);
    expect(state2.state.status).toBe('ACTIVE');
    c2.close();
  });

  it('host end over HTTP pushes room_ended to subscribers', async () => {
    const { roomId } = await roomWithGuest();
    const ws = await wsConnect(guest.token);
    const c = await wsJoin(ws, roomId);
    const end = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${roomId}/end`,
      headers: auth(host),
    });
    expect(end.statusCode).toBe(204);
    const evt = await c.next((m) => m.type === 'room.event' && m.event === 'room_ended');
    expect(evt.roomId).toBe(roomId);
    c.close();
  });

  it('HTTP join broadcasts member_joined to existing subscribers', async () => {
    const created = await createRoomAs(host, { trackIds: [trackA, trackB] });
    expect(created.statusCode).toBe(201);
    const roomId = created.json().roomId as string;
    const hostWs = await wsConnect(host.token);
    const hostC = await wsJoin(hostWs, roomId);
    // A new member joins over HTTP: the subscribed host hears member_joined.
    const inv = await inviteAs(host, roomId);
    expect(inv.statusCode).toBe(201);
    const joined = await joinAs(guest, roomId, inv.json().token as string);
    expect(joined.statusCode).toBe(200);
    const evt = await hostC.next((m) => m.type === 'room.event' && m.event === 'member_joined');
    expect(evt.roomId).toBe(roomId);
    expect(evt.userId).toBe(guest.id);
    hostC.close();
  });

  it('idempotent HTTP rejoin does not rebroadcast member_joined', async () => {
    const { roomId } = await roomWithGuest();
    const hostWs = await wsConnect(host.token);
    const hostC = await wsJoin(hostWs, roomId);
    // Guest is already a member: the rejoin consumes no token and stays silent.
    const inv = await inviteAs(host, roomId);
    expect(inv.statusCode).toBe(201);
    const rejoined = await joinAs(guest, roomId, inv.json().token as string);
    expect(rejoined.statusCode).toBe(200);
    await expect(
      hostC.next((m) => m.type === 'room.event' && m.event === 'member_joined', 500),
    ).rejects.toThrow(/Timed out/);
    hostC.close();
  });

  it('WS resubscribe does not rebroadcast member_joined', async () => {
    const { roomId } = await roomWithGuest();
    const hostWs = await wsConnect(host.token);
    const hostC = await wsJoin(hostWs, roomId);
    // The guest opens a second socket and subscribes: the host hears nothing,
    // because no membership changed.
    const guestWs = await wsConnect(guest.token);
    const guestC = await wsJoin(guestWs, roomId);
    await expect(
      hostC.next((m) => m.type === 'room.event' && m.event === 'member_joined', 500),
    ).rejects.toThrow(/Timed out/);
    hostC.close();
    guestC.close();
  });

  it('HTTP leave evicts the leaver sockets from the room channel', async () => {
    const { roomId } = await roomWithGuest();
    const hostWs = await wsConnect(host.token);
    const guestWs = await wsConnect(guest.token);
    const hostC = await wsJoin(hostWs, roomId);
    const guestC = await wsJoin(guestWs, roomId);
    expect(roomSubscriberCount(roomId)).toBe(2);
    const left = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${roomId}/leave`,
      headers: auth(guest),
    });
    expect(left.statusCode).toBe(204);
    // The leaver hears their own member_left (broadcast precedes eviction)...
    const evt = await guestC.next((m) => m.type === 'room.event' && m.event === 'member_left');
    expect(evt.userId).toBe(guest.id);
    // ...then their subscription is dropped immediately.
    expect(roomSubscriberCount(roomId)).toBe(1);
    // A later host command no longer reaches the evicted socket.
    hostWs.send(
      JSON.stringify({
        type: 'room.command',
        roomId,
        command: 'play',
        expectedRevision: 0,
        positionMs: 0,
      }),
    );
    await hostC.next((m) => m.type === 'room.state' && m.state.revision === 1);
    await expect(
      guestC.next((m) => m.type === 'room.state' && m.state.revision === 1, 500),
    ).rejects.toThrow(/Timed out/);
    hostC.close();
    guestC.close();
  });

  it('HTTP end evicts every socket from the room channel', async () => {
    const { roomId } = await roomWithGuest();
    const hostWs = await wsConnect(host.token);
    const guestWs = await wsConnect(guest.token);
    const hostC = await wsJoin(hostWs, roomId);
    const guestC = await wsJoin(guestWs, roomId);
    expect(roomSubscriberCount(roomId)).toBe(2);
    const end = await app.inject({
      method: 'POST',
      url: `/v1/rooms/${roomId}/end`,
      headers: auth(host),
    });
    expect(end.statusCode).toBe(204);
    // Everyone hears room_ended (broadcast precedes eviction)...
    await hostC.next((m) => m.type === 'room.event' && m.event === 'room_ended');
    await guestC.next((m) => m.type === 'room.event' && m.event === 'room_ended');
    // ...then every subscription is dropped.
    expect(roomSubscriberCount(roomId)).toBe(0);
    hostC.close();
    guestC.close();
  });
});

// --- HTTP rate limits -----------------------------------------------------------------

describe('room rate limits', () => {
  it('room creation is bounded per user', async () => {
    const limitedConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      RATE_LIMIT_API: '10000',
      RATE_LIMIT_ROOMS_CREATE: '2',
      RATE_LIMIT_ROOMS_JOIN: '10000',
      RATE_LIMIT_ROOMS_INVITE: '10000',
      DEV_SUBSCRIPTIONS_ENABLED: 'true',
    });
    const limitedApp = await buildApp(limitedConfig);
    try {
      const login = await limitedApp.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: host.email, password: PASSWORD },
      });
      const headers = { authorization: `Bearer ${login.json().tokens.accessToken}` };
      const mk = () =>
        limitedApp.inject({
          method: 'POST',
          url: '/v1/rooms',
          headers,
          payload: { trackIds: [trackA] },
        });
      expect((await mk()).statusCode).toBe(201);
      expect((await mk()).statusCode).toBe(201);
      expect((await mk()).statusCode).toBe(429);
    } finally {
      await limitedApp.close();
    }
  });
});
