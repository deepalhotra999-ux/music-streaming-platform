/**
 * Phase 4 backend API tests — full HTTP stack via `app.inject()`.
 * Runs against TEST_DATABASE_URL (see vitest.config.ts) — never the dev DB.
 *
 * Cleanup is scoped to `@phase4-test.local` addresses so suites sharing the
 * test database never touch each other's rows (files also run sequentially).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';

const TEST_DOMAIN = '@phase4-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase4-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;

/** FK-safe cleanup, children before parents. */
async function scopedClean(): Promise<void> {
  const userWhere = { user: { email: { endsWith: TEST_DOMAIN } } };
  const storeWhere = { store: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } } };
  // Phase 30 commerce tables (children before parents). commerce_payment_events
  // is append-only (triggers reject DELETE); disable them for test cleanup.
  await prisma.$executeRawUnsafe(
    'ALTER TABLE commerce_payment_events DISABLE TRIGGER commerce_payment_events_no_update',
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE commerce_payment_events DISABLE TRIGGER commerce_payment_events_no_delete',
  );
  try {
    await prisma.commercePaymentEvent.deleteMany({ where: { payment: { order: storeWhere } } });
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE commerce_payment_events ENABLE TRIGGER commerce_payment_events_no_update',
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE commerce_payment_events ENABLE TRIGGER commerce_payment_events_no_delete',
    );
  }
  await prisma.commerceRefund.deleteMany({ where: { order: storeWhere } });
  await prisma.commercePayment.deleteMany({ where: { order: storeWhere } });
  await prisma.commerceOrderItem.deleteMany({ where: { order: storeWhere } });
  await prisma.commerceOrder.deleteMany({ where: storeWhere });
  await prisma.cartItem.deleteMany({ where: { cart: userWhere } });
  await prisma.cart.deleteMany({ where: userWhere });
  await prisma.inventoryItem.deleteMany({ where: { product: storeWhere } });
  await prisma.productImage.deleteMany({ where: { product: storeWhere } });
  await prisma.productVariant.deleteMany({ where: { product: storeWhere } });
  await prisma.product.deleteMany({ where: storeWhere });
  await prisma.artistStore.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.listeningHistory.deleteMany({ where: userWhere });
  await prisma.like.deleteMany({ where: userWhere });
  await prisma.follow.deleteMany({ where: userWhere });
  await prisma.playlistTrack.deleteMany({
    where: { playlist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.playlist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.trackGenre.deleteMany({
    where: { track: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } } },
  });
  await prisma.track.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.album.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artistProfile.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.refreshToken.deleteMany({ where: userWhere });
  // Phase 16 — admin audit rows are append-only (the DB trigger rejects even
  // the FK's ON DELETE SET NULL maintenance update), so retire this suite's
  // audit rows explicitly before deleting its users. Scoped to this suite's
  // actor domain, like everything else here.
  await prisma.$executeRawUnsafe(
    'ALTER TABLE admin_audit_logs DISABLE TRIGGER admin_audit_logs_no_mutation',
  );
  try {
    await prisma.adminAuditLog.deleteMany({
      where: { actor: { email: { endsWith: TEST_DOMAIN } } },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE admin_audit_logs ENABLE TRIGGER admin_audit_logs_no_mutation',
    );
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
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
  });
  app = await buildApp(config);
  await scopedClean();
});

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
});

interface TestUser {
  id: string;
  email: string;
  token: string;
}

async function createUser(tag: string, role: 'LISTENER' | 'ARTIST' | 'ADMIN'): Promise<TestUser> {
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

function expectProblemJson(res: { headers: Record<string, unknown> }) {
  expect(String(res.headers['content-type'])).toMatch('application/problem+json');
}

function expectPage(json: unknown, expectedPage = 1) {
  expect(json).toHaveProperty('data');
  expect(json).toHaveProperty('pagination');
  const p = (json as { pagination: Record<string, number> }).pagination;
  expect(p.page).toBe(expectedPage);
  expect(p).toHaveProperty('limit');
  expect(p).toHaveProperty('total');
  expect(p).toHaveProperty('totalPages');
}

// ---------------------------------------------------------------------------
// Fixtures shared across suites
// ---------------------------------------------------------------------------
let listener: TestUser;
let artistUser: TestUser;
let artistUser2: TestUser;
let admin: TestUser;
let artistId: string;
let albumId: string;
let trackId: string;
let genreId: string;
const TRACK_DURATION = 180_000;

beforeAll(async () => {
  listener = await createUser('listener', 'LISTENER');
  artistUser = await createUser('artist', 'ARTIST');
  artistUser2 = await createUser('artist2', 'ARTIST');
  admin = await createUser('admin', 'ADMIN');

  const artistRes = await app.inject({
    method: 'POST',
    url: '/v1/artists',
    headers: auth(artistUser),
    payload: { name: 'Phase4 Test Artist' },
  });
  expect(artistRes.statusCode).toBe(201);
  artistId = artistRes.json().id as string;

  const albumRes = await app.inject({
    method: 'POST',
    url: '/v1/albums',
    headers: auth(artistUser),
    payload: { title: 'Phase4 Test Album', artistId },
  });
  expect(albumRes.statusCode).toBe(201);
  albumId = albumRes.json().id as string;

  const trackRes = await app.inject({
    method: 'POST',
    url: '/v1/tracks',
    headers: auth(artistUser),
    payload: { title: 'Phase4 Test Track', artistId, albumId, durationMs: TRACK_DURATION },
  });
  expect(trackRes.statusCode).toBe(201);
  trackId = trackRes.json().id as string;

  const genreRes = await app.inject({
    method: 'POST',
    url: '/v1/genres',
    headers: auth(admin),
    payload: { name: 'Phase4 Test Genre' },
  });
  expect(genreRes.statusCode).toBe(201);
  genreId = genreRes.json().id as string;
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
describe('users', () => {
  it('admin lists users with the standard page envelope (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users', headers: auth(admin) });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expectPage(json);
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data[0]).toHaveProperty('email');
  });

  it('paginates with page/limit (200)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users?limit=1&page=2',
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expectPage(json, 2);
    expect(json.pagination.limit).toBe(1);
    expect(json.data).toHaveLength(1);
  });

  it('rejects invalid pagination (400, RFC 7807)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users?page=0',
      headers: auth(admin),
    });
    expect(res.statusCode).toBe(400);
    expectProblemJson(res);
  });

  it('rejects non-admin listing (403)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users', headers: auth(listener) });
    expect(res.statusCode).toBe(403);
    expectProblemJson(res);
  });

  it('rejects anonymous listing (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users' });
    expect(res.statusCode).toBe(401);
  });

  it('hides email from other users but shows it to self and admin', async () => {
    const other = await app.inject({
      method: 'GET',
      url: `/v1/users/${artistUser.id}`,
      headers: auth(listener),
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).not.toHaveProperty('email');

    const self = await app.inject({
      method: 'GET',
      url: `/v1/users/${listener.id}`,
      headers: auth(listener),
    });
    expect(self.json().email).toBe(listener.email);

    const asAdmin = await app.inject({
      method: 'GET',
      url: `/v1/users/${listener.id}`,
      headers: auth(admin),
    });
    expect(asAdmin.json().email).toBe(listener.email);
  });

  it('returns 404 for unknown user', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/00000000-0000-4000-8000-000000000000',
      headers: auth(listener),
    });
    expect(res.statusCode).toBe(404);
  });

  it('lets a user update their own profile (200)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/users/me',
      headers: auth(listener),
      payload: { displayName: 'Renamed Listener', countryCode: 'us' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().displayName).toBe('Renamed Listener');
    expect(res.json().countryCode).toBe('US');
  });

  it('rejects empty profile updates (400)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/users/me',
      headers: auth(listener),
      payload: { displayName: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('admin changes a user role; cannot change their own (200 / 403)', async () => {
    const promote = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${listener.id}/role`,
      headers: auth(admin),
      payload: { role: 'ARTIST' },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().role).toBe('ARTIST');
    // Restore for the rest of the suite.
    await prisma.user.update({ where: { id: listener.id }, data: { role: 'LISTENER' } });

    const self = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${admin.id}/role`,
      headers: auth(admin),
      payload: { role: 'LISTENER' },
    });
    expect(self.statusCode).toBe(403);
  });

  it('rejects role change by non-admin (403)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/users/${listener.id}/role`,
      headers: auth(listener),
      payload: { role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Artists
// ---------------------------------------------------------------------------
describe('artists', () => {
  it('public catalog read needs no token (200)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/artists' });
    expect(res.statusCode).toBe(200);
    expectPage(res.json());
  });

  it('rejects artist creation by listeners (403) but allows artists (201)', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/artists',
      headers: auth(listener),
      payload: { name: 'Nope' },
    });
    expect(denied.statusCode).toBe(403);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/artists',
      headers: auth(artistUser2),
      payload: { name: 'Second Artist' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('Second Artist');
    expect(res.json().counts).toEqual({ albums: 0, tracks: 0, followers: 0 });
  });

  it('owner updates their artist; others get 403; admin can verify', async () => {
    const own = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${artistId}`,
      headers: auth(artistUser),
      payload: { name: 'Renamed Artist' },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().name).toBe('Renamed Artist');

    const other = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${artistId}`,
      headers: auth(artistUser2),
      payload: { name: 'Hijacked' },
    });
    expect(other.statusCode).toBe(403);

    const verifyAttempt = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${artistId}`,
      headers: auth(artistUser),
      payload: { verified: true },
    });
    expect(verifyAttempt.statusCode).toBe(403);

    const verify = await app.inject({
      method: 'PATCH',
      url: `/v1/artists/${artistId}`,
      headers: auth(admin),
      payload: { verified: true },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().verified).toBe(true);
  });

  it('manages the artist profile (PUT/GET, owner-only writes)', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/artists/${artistId}/profile`,
      headers: auth(artistUser),
      payload: { bio: 'Test bio', website: 'https://example.com' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().bio).toBe('Test bio');

    const denied = await app.inject({
      method: 'PUT',
      url: `/v1/artists/${artistId}/profile`,
      headers: auth(artistUser2),
      payload: { bio: 'Hijack' },
    });
    expect(denied.statusCode).toBe(403);

    const get = await app.inject({ method: 'GET', url: `/v1/artists/${artistId}/profile` });
    expect(get.statusCode).toBe(200);
    expect(get.json().bio).toBe('Test bio');
  });

  it('lists the caller’s own artists at /v1/me/artists', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/artists',
      headers: auth(artistUser),
    });
    expect(res.statusCode).toBe(200);
    expectPage(res.json());
    expect(res.json().data.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to delete an artist that still has tracks (409), then 204 when empty', async () => {
    const blocked = await app.inject({
      method: 'DELETE',
      url: `/v1/artists/${artistId}`,
      headers: auth(artistUser),
    });
    expect(blocked.statusCode).toBe(409);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/artists',
      headers: auth(artistUser),
      payload: { name: 'Disposable Artist' },
    });
    const disposableId = created.json().id as string;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/artists/${disposableId}`,
      headers: auth(artistUser),
    });
    expect(deleted.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/v1/artists/${disposableId}` });
    expect(gone.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Albums & tracks
// ---------------------------------------------------------------------------
describe('albums and tracks', () => {
  it('public album list and detail with embedded tracks (200)', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/albums' });
    expect(list.statusCode).toBe(200);
    expectPage(list.json());

    const detail = await app.inject({ method: 'GET', url: `/v1/albums/${albumId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().tracks).toHaveLength(1);
    expect(detail.json().tracks[0].title).toBe('Phase4 Test Track');
  });

  it('rejects album creation for another artist’s profile (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/albums',
      headers: auth(artistUser2),
      payload: { title: 'Hijack Album', artistId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to delete an album that still has tracks (409)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/albums/${albumId}`,
      headers: auth(artistUser),
    });
    expect(res.statusCode).toBe(409);
  });

  it('public track list, filters, and detail (200)', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/tracks' });
    expect(list.statusCode).toBe(200);
    expectPage(list.json());

    const filtered = await app.inject({
      method: 'GET',
      url: `/v1/tracks?artistId=${artistId}&status=PROCESSING`,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().data.length).toBeGreaterThanOrEqual(1);

    const detail = await app.inject({ method: 'GET', url: `/v1/tracks/${trackId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().playCount).toBe(0);
    expect(detail.json().genres).toEqual([]);
  });

  it('rejects duplicate ISRC (409) and album/artist mismatch (400)', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/tracks',
      headers: auth(artistUser),
      payload: { title: 'ISRC Track', artistId, durationMs: 60000, isrc: 'PH4A-TEST-0001' },
    });
    expect(first.statusCode).toBe(201);

    const dup = await app.inject({
      method: 'POST',
      url: '/v1/tracks',
      headers: auth(artistUser),
      payload: { title: 'ISRC Dup', artistId, durationMs: 60000, isrc: 'PH4A-TEST-0001' },
    });
    expect(dup.statusCode).toBe(409);

    const otherArtistRes = await app.inject({
      method: 'POST',
      url: '/v1/artists',
      headers: auth(artistUser2),
      payload: { name: 'Mismatch Artist' },
    });
    const otherArtistId = otherArtistRes.json().id as string;
    const mismatch = await app.inject({
      method: 'POST',
      url: '/v1/tracks',
      headers: auth(artistUser2),
      payload: { title: 'Mismatch', artistId: otherArtistId, albumId, durationMs: 60000 },
    });
    expect(mismatch.statusCode).toBe(400);
  });

  it('rejects track creation by listeners (403)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tracks',
      headers: auth(listener),
      payload: { title: 'Nope', artistId, durationMs: 60000 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('Phase 14 — manual READY is rejected; only the pipeline publishes (422)', async () => {
    const createReady = await app.inject({
      method: 'POST',
      url: '/v1/tracks',
      headers: auth(artistUser),
      payload: { title: 'Manual Ready', artistId, durationMs: 60000, status: 'READY' },
    });
    expect(createReady.statusCode).toBe(422);

    const updateReady = await app.inject({
      method: 'PATCH',
      url: `/v1/tracks/${trackId}`,
      headers: auth(artistUser),
      payload: { status: 'READY' },
    });
    expect(updateReady.statusCode).toBe(422);

    // Other manual transitions are untouched: takedown and restore work.
    const down = await app.inject({
      method: 'PATCH',
      url: `/v1/tracks/${trackId}`,
      headers: auth(artistUser),
      payload: { status: 'TAKEDOWN' },
    });
    expect(down.statusCode).toBe(200);
    expect(down.json().status).toBe('TAKEDOWN');
    const restore = await app.inject({
      method: 'PATCH',
      url: `/v1/tracks/${trackId}`,
      headers: auth(artistUser),
      payload: { status: 'PROCESSING' },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().status).toBe('PROCESSING');
  });
});

// ---------------------------------------------------------------------------
// Genres
// ---------------------------------------------------------------------------
describe('genres', () => {
  it('public list; admin create; duplicate 409; listener 403', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/genres' });
    expect(list.statusCode).toBe(200);
    expectPage(list.json());

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/genres',
      headers: auth(listener),
      payload: { name: 'Nope Genre' },
    });
    expect(denied.statusCode).toBe(403);

    const dup = await app.inject({
      method: 'POST',
      url: '/v1/genres',
      headers: auth(admin),
      payload: { name: 'Phase4 Test Genre' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('refuses to delete a genre that has tracks (409)', async () => {
    // Attach the fixture track to the fixture genre directly.
    await prisma.trackGenre.create({ data: { trackId, genreId } });

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/v1/genres/${genreId}`,
      headers: auth(admin),
    });
    expect(blocked.statusCode).toBe(409);

    const filtered = await app.inject({ method: 'GET', url: `/v1/tracks?genreId=${genreId}` });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().data.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------
describe('playlists', () => {
  let privateId: string;
  let publicId: string;
  let unlistedId: string;

  it('creates playlists (default PRIVATE) and paginates /v1/me/playlists', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(listener),
      payload: { title: 'My Private Mix' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().visibility).toBe('PRIVATE');
    expect(created.json().items).toEqual([]);
    privateId = created.json().id as string;

    const pub = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(listener),
      payload: { title: 'My Public Mix', visibility: 'PUBLIC' },
    });
    expect(pub.statusCode).toBe(201);
    publicId = pub.json().id as string;

    const unl = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(listener),
      payload: { title: 'My Unlisted Mix', visibility: 'UNLISTED' },
    });
    unlistedId = unl.json().id as string;

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/me/playlists',
      headers: auth(listener),
    });
    expect(mine.statusCode).toBe(200);
    expectPage(mine.json());
    expect(mine.json().data.length).toBe(3);
  });

  it('enforces visibility: public open, unlisted needs auth, private is invisible (404)', async () => {
    const pubAnon = await app.inject({ method: 'GET', url: `/v1/playlists/${publicId}` });
    expect(pubAnon.statusCode).toBe(200);

    const unlAnon = await app.inject({ method: 'GET', url: `/v1/playlists/${unlistedId}` });
    expect(unlAnon.statusCode).toBe(401);

    const unlAuthed = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${unlistedId}`,
      headers: auth(artistUser),
    });
    expect(unlAuthed.statusCode).toBe(200);

    const privOther = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${privateId}`,
      headers: auth(artistUser),
    });
    expect(privOther.statusCode).toBe(404);

    const privAnon = await app.inject({ method: 'GET', url: `/v1/playlists/${privateId}` });
    expect(privAnon.statusCode).toBe(404);
  });

  it('lists public playlists without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/playlists/public' });
    expect(res.statusCode).toBe(200);
    expectPage(res.json());
    expect(res.json().data.some((p: { id: string }) => p.id === publicId)).toBe(true);
    expect(res.json().data.some((p: { id: string }) => p.id === privateId)).toBe(false);
  });

  it('manages playlist items: add, reorder, remove; strangers get 404', async () => {
    const add = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${privateId}/tracks`,
      headers: auth(listener),
      payload: { trackId },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json().position).toBe(1);
    expect(add.json().track.title).toBe('Phase4 Test Track');
    const itemId = add.json().id as string;

    const add2 = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${privateId}/tracks`,
      headers: auth(listener),
      payload: { trackId, position: 0.5 },
    });
    expect(add2.statusCode).toBe(201);
    const itemId2 = add2.json().id as string;

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/playlists/${privateId}`,
      headers: auth(listener),
    });
    expect(detail.json().items.map((i: { id: string }) => i.id)).toEqual([itemId2, itemId]);

    const move = await app.inject({
      method: 'PATCH',
      url: `/v1/playlists/${privateId}/tracks/${itemId2}`,
      headers: auth(listener),
      payload: { position: 5 },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json().position).toBe(5);

    const strangerAdd = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${privateId}/tracks`,
      headers: auth(artistUser),
      payload: { trackId },
    });
    expect(strangerAdd.statusCode).toBe(404);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${privateId}/tracks/${itemId2}`,
      headers: auth(listener),
    });
    expect(remove.statusCode).toBe(204);

    const missingTrack = await app.inject({
      method: 'POST',
      url: `/v1/playlists/${privateId}/tracks`,
      headers: auth(listener),
      payload: { trackId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(missingTrack.statusCode).toBe(404);
  });

  it('refuses to delete a track that sits in a playlist (409)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/tracks/${trackId}`,
      headers: auth(artistUser),
    });
    expect(res.statusCode).toBe(409);
  });

  it('deletes a playlist (204); strangers cannot', async () => {
    const denied = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${privateId}`,
      headers: auth(artistUser),
    });
    expect(denied.statusCode).toBe(404);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/playlists/${privateId}`,
      headers: auth(listener),
    });
    expect(res.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Likes & follows
// ---------------------------------------------------------------------------
describe('likes and follows', () => {
  it('like is idempotent (201 then 200), list, unlike (204)', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/me/likes',
      headers: auth(listener),
      payload: { trackId },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().track.title).toBe('Phase4 Test Track');

    const second = await app.inject({
      method: 'POST',
      url: '/v1/me/likes',
      headers: auth(listener),
      payload: { trackId },
    });
    expect(second.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/v1/me/likes', headers: auth(listener) });
    expect(list.statusCode).toBe(200);
    expectPage(list.json());
    expect(list.json().data).toHaveLength(1);

    const unlike = await app.inject({
      method: 'DELETE',
      url: `/v1/me/likes/${trackId}`,
      headers: auth(listener),
    });
    expect(unlike.statusCode).toBe(204);

    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/me/likes/${trackId}`,
      headers: auth(listener),
    });
    expect(again.statusCode).toBe(204);

    const empty = await app.inject({ method: 'GET', url: '/v1/me/likes', headers: auth(listener) });
    expect(empty.json().data).toHaveLength(0);
  });

  it('rejects liking a missing track (404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/likes',
      headers: auth(listener),
      payload: { trackId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('follow is idempotent (201 then 200), list, unfollow (204)', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/me/follows',
      headers: auth(listener),
      payload: { artistId },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/me/follows',
      headers: auth(listener),
      payload: { artistId },
    });
    expect(second.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/follows',
      headers: auth(listener),
    });
    expect(list.statusCode).toBe(200);
    expectPage(list.json());
    expect(list.json().data[0].artist.name).toBe('Renamed Artist');

    const unfollow = await app.inject({
      method: 'DELETE',
      url: `/v1/me/follows/${artistId}`,
      headers: auth(listener),
    });
    expect(unfollow.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Listening history
// ---------------------------------------------------------------------------
describe('listening history', () => {
  it('records plays; completed plays bump playCount (201)', async () => {
    const before = await app.inject({ method: 'GET', url: `/v1/tracks/${trackId}` });
    const beforeCount = before.json().playCount as number;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/history',
      headers: auth(listener),
      payload: { trackId, progressMs: 30000, completed: false },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().completed).toBe(false);

    const done = await app.inject({
      method: 'POST',
      url: '/v1/me/history',
      headers: auth(listener),
      payload: { trackId, completed: true },
    });
    expect(done.statusCode).toBe(201);

    const after = await app.inject({ method: 'GET', url: `/v1/tracks/${trackId}` });
    expect(after.json().playCount).toBe(beforeCount + 1);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/history',
      headers: auth(listener),
    });
    expect(list.statusCode).toBe(200);
    expectPage(list.json());
    expect(list.json().data.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects progressMs beyond the track duration (400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/history',
      headers: auth(listener),
      payload: { trackId, progressMs: TRACK_DURATION + 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('clears history (204)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/me/history',
      headers: auth(listener),
    });
    expect(res.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/history',
      headers: auth(listener),
    });
    expect(list.json().data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAPI docs
// ---------------------------------------------------------------------------
describe('openapi docs', () => {
  it('serves the generated OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\.0\./);
    expect(spec.paths).toHaveProperty('/v1/artists');
    expect(spec.paths).toHaveProperty('/v1/tracks');
    expect(spec.paths).toHaveProperty('/v1/playlists/public');
    expect(spec.paths).toHaveProperty('/v1/me/history');
    expect(spec.components.securitySchemes).toHaveProperty('bearerAuth');
  });

  it('serves the Swagger UI', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/' });
    expect([200, 302]).toContain(res.statusCode);
  });
});
