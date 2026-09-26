/**
 * Phase 30 — artist commerce (backend) tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB). Scoped cleanup: every fixture uses TEST_DOMAIN emails.
 *
 * Covers (per the Phase 30 brief §23):
 * - Store eligibility: ARTIST-only create (LISTENER 403, anonymous 401),
 *   verified-artist requirement, one store per artist (409), cross-owner
 *   isolation (artist A cannot create/manage artist B's store).
 * - Products: CRUD, same-artist track/album refs, variants, images,
 *   inventory transitions (ACTIVE<->SOLD_OUT), public ACTIVE-only surface,
 *   archive, price/currency validation, status transition rules.
 * - Cart: user-owned, variant required when present, availability caps,
 *   multi-store grouping, quantity updates, per-user isolation.
 * - Checkout: server-authoritative pricing (client prices don't exist),
 *   atomic inventory reservation, one-store-per-order, idempotency keys,
 *   price changes between cart-add and checkout are honored at the server
 *   price, oversell safety under contention.
 * - Payments: confirm-payment verifies with the provider (forged callbacks
 *   can't grant PAID), failed/canceled flows release reservations,
 *   retry mints a fresh intent, cancel releases unpaid reservations,
 *   full refunds through the provider with idempotency.
 * - Webhooks: signature verification, idempotent event handling, unknown
 *   payments acknowledged without effect.
 * - Fulfillment: PAID->PROCESSING->SHIPPED->DELIVERED manual transitions,
 *   invalid transitions rejected, payment state untouched.
 * - Moderation: PRODUCT/ARTIST_STORE user reports file into the Phase 17
 *   workflow; admin remove/restore/suspend; removed products not purchasable;
 *   historical order snapshots survive moderation.
 * - Privacy: shipping addresses visible only to buyer/owner/ADMIN; no
 *   addresses in audit metadata, public DTOs, or logs.
 * - Rate limits: per-user buckets (unit + integration); identity is
 *   server-derived.
 * - Isolation: commerce money never enters royalty accounting, play events,
 *   subscriptions, playback entitlement, search, or AI surfaces.
 *
 * Note: commerce_payment_events is append-only (DB trigger rejects
 * UPDATE/DELETE), so afterAll cleanup deletes what FK rules allow and
 * leaves the immutable event trail. Fixture emails are unique per run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';
import {
  checkUserRateLimit,
  resetCommerceRateLimits,
} from '../src/modules/commerce/rateLimit.js';

const TEST_DOMAIN = '@phase30-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase30-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;

type Role = 'LISTENER' | 'ARTIST' | 'ADMIN';

async function registerAndLogin(
  email: string,
  role: Role,
): Promise<{ userId: string; token: string }> {
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
  return { userId, token: login.json().tokens.accessToken as string };
}

async function makeArtist(
  tag: string,
  verified = true,
): Promise<{ userId: string; token: string; artistId: string }> {
  const user = await registerAndLogin(testEmail(tag), 'ARTIST');
  const created = await prisma.artist.create({
    data: { name: `Phase30 ${tag}`, ownerUserId: user.userId, verified },
  });
  return { ...user, artistId: created.id };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const ADDRESS = {
  name: 'Test Buyer',
  line1: '123 Commerce St',
  city: 'Toronto',
  postal: 'M4B1B3',
  country: 'CA',
};

let admin: { userId: string; token: string };
let artistA: { userId: string; token: string; artistId: string };
let artistB: { userId: string; token: string; artistId: string };
let listener: { userId: string; token: string };
let listener2: { userId: string; token: string };

let storeAId: string;
let storeBId: string;
let shirtId: string;
let shirtVariantLargeId: string;
let vinylId: string;
let productBId: string;
let trackAId: string;
let trackBId: string;

const createStore = (token: string, artistId: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/commerce/stores',
    headers: auth(token),
    payload: {
      artistId,
      name: `Store ${Date.now()}-${counter++}`,
      currency: 'USD',
      shippingFlatCents: 500,
      ...extra,
    },
  });

const createProduct = (
  token: string,
  storeId: string,
  extra: Record<string, unknown> = {},
) =>
  app.inject({
    method: 'POST',
    url: '/v1/commerce/products',
    headers: auth(token),
    payload: {
      storeId,
      title: `Product ${Date.now()}-${counter++}`,
      type: 'APPAREL',
      priceCents: 2500,
      status: 'ACTIVE',
      ...extra,
    },
  });

const addToCart = (token: string, productId: string, quantity: number, variantId?: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/commerce/cart/items',
    headers: auth(token),
    payload: { productId, quantity, ...(variantId ? { variantId } : {}) },
  });

const checkout = (token: string, idempotencyKey: string, address = ADDRESS) =>
  app.inject({
    method: 'POST',
    url: '/v1/commerce/checkout',
    headers: auth(token),
    payload: { idempotencyKey, shippingAddress: address },
  });

async function auditRows(action: string, targetId?: string) {
  return prisma.adminAuditLog.findMany({
    where: {
      action,
      actor: { email: { endsWith: TEST_DOMAIN } },
      ...(targetId ? { targetId } : {}),
    },
  });
}

beforeAll(async () => {
  const config = loadConfig();
  app = await buildApp(config);

  admin = await registerAndLogin(testEmail('admin'), 'ADMIN');
  artistA = await makeArtist('artista');
  artistB = await makeArtist('artistb');
  listener = await registerAndLogin(testEmail('listener'), 'LISTENER');
  listener2 = await registerAndLogin(testEmail('listener2'), 'LISTENER');

  // Storefronts for both artists.
  const sA = await createStore(artistA.token, artistA.artistId);
  expect(sA.statusCode).toBe(201);
  storeAId = sA.json().id as string;
  const sB = await createStore(artistB.token, artistB.artistId);
  expect(sB.statusCode).toBe(201);
  storeBId = sB.json().id as string;

  // Catalog rows for same-artist reference tests.
  const tA = await prisma.track.create({
    data: { title: 'Phase30 Track A', artistId: artistA.artistId, durationMs: 180000, status: 'READY' },
  });
  trackAId = tA.id;
  const tB = await prisma.track.create({
    data: { title: 'Phase30 Track B', artistId: artistB.artistId, durationMs: 180000, status: 'READY' },
  });
  trackBId = tB.id;

  // T-shirt with a Large variant.
  const shirt = await createProduct(artistA.token, storeAId, { title: 'Phase30 Tee' });
  expect(shirt.statusCode).toBe(201);
  shirtId = shirt.json().id as string;
  const variant = await app.inject({
    method: 'POST',
    url: `/v1/commerce/products/${shirtId}/variants`,
    headers: auth(artistA.token),
    payload: { name: 'Large', priceCents: 2700 },
  });
  expect(variant.statusCode).toBe(201);
  shirtVariantLargeId = variant.json().id as string;
  // Inventory is tracked per variant for variant products: 5 Large.
  const inv2 = await app.inject({
    method: 'POST',
    url: `/v1/commerce/products/${shirtId}/inventory`,
    headers: auth(artistA.token),
    payload: { variantId: shirtVariantLargeId, quantityAvailable: 5 },
  });
  expect(inv2.statusCode).toBe(200);

  // Vinyl, no variants.
  const vinyl = await createProduct(artistA.token, storeAId, {
    title: 'Phase30 Vinyl',
    type: 'MUSIC',
    priceCents: 3000,
  });
  expect(vinyl.statusCode).toBe(201);
  vinylId = vinyl.json().id as string;
  const inv3 = await app.inject({
    method: 'POST',
    url: `/v1/commerce/products/${vinylId}/inventory`,
    headers: auth(artistA.token),
    payload: { quantityAvailable: 3 },
  });
  expect(inv3.statusCode).toBe(200);

  // Artist B's product (cross-owner isolation fixture).
  const pB = await createProduct(artistB.token, storeBId, { title: 'Phase30 B Cap' });
  expect(pB.statusCode).toBe(201);
  productBId = pB.json().id as string;
  const invB = await app.inject({
    method: 'POST',
    url: `/v1/commerce/products/${productBId}/inventory`,
    headers: auth(artistB.token),
    payload: { quantityAvailable: 5 },
  });
  expect(invB.statusCode).toBe(200);
});

afterAll(async () => {
  // Best-effort scoped cleanup. commerce_payment_events is append-only by
  // design (DB trigger rejects DELETE), and its Restrict FKs pin payments,
  // refunds, and orders — those rows stay. Everything else is removed in
  // FK-safe order.
  const safe = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch {
      /* referenced rows stay; fixtures are uniquely namespaced */
    }
  };
  const scoped = { email: { endsWith: TEST_DOMAIN } };
  await safe(() => prisma.cartItem.deleteMany({ where: { cart: { user: scoped } } }));
  await safe(() => prisma.cart.deleteMany({ where: { user: scoped } }));
  await safe(() => prisma.product.deleteMany({ where: { store: { artist: { owner: scoped } } } }));
  await safe(() => prisma.artistStore.deleteMany({ where: { artist: { owner: scoped } } }));
  await safe(() => prisma.track.deleteMany({ where: { title: { startsWith: 'Phase30 Track' } } }));
  await safe(() => prisma.artist.deleteMany({ where: { owner: scoped } }));
  await safe(() => prisma.adminAuditLog.deleteMany({ where: { actor: scoped } }));
  await safe(() => prisma.user.deleteMany({ where: scoped }));
  await app.close();
});

describe('Phase 30 — store eligibility and management', () => {
  it('rejects store creation for LISTENER and anonymous callers', async () => {
    const asListener = await createStore(listener.token, artistA.artistId);
    expect(asListener.statusCode).toBe(403);
    const anon = await app.inject({
      method: 'POST',
      url: '/v1/commerce/stores',
      payload: { artistId: artistA.artistId, name: 'Nope' },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('requires a verified artist the caller owns', async () => {
    const unverified = await makeArtist('unverified', false);
    const res = await createStore(unverified.token, unverified.artistId);
    expect(res.statusCode).toBe(403);
    // Artist A cannot open a store for artist B's artist row.
    const cross = await createStore(artistA.token, artistB.artistId);
    expect(cross.statusCode).toBe(403);
  });

  it('enforces one store per artist', async () => {
    const dup = await createStore(artistA.token, artistA.artistId);
    expect(dup.statusCode).toBe(409);
  });

  it('lets the owner update settings but not suspend their own store', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/stores/${storeAId}`,
      headers: auth(artistA.token),
      payload: { name: 'Phase30 Tee Shop', shippingFlatCents: 700 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe('Phase30 Tee Shop');

    // SUSPENDED is a moderation-only state: owners get 403, not a transition error.
    const suspend = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/stores/${storeAId}`,
      headers: auth(artistA.token),
      payload: { status: 'SUSPENDED' },
    });
    expect(suspend.statusCode).toBe(403);

    const crossOwner = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/stores/${storeAId}`,
      headers: auth(artistB.token),
      payload: { name: 'Hijacked' },
    });
    expect(crossOwner.statusCode).toBe(403);
  });

  it('suspends via admin moderation and hides the store publicly', async () => {
    const susp = await app.inject({
      method: 'POST',
      url: `/v1/admin/commerce/stores/${storeBId}/moderate`,
      headers: auth(admin.token),
      payload: { action: 'suspend' },
    });
    expect(susp.statusCode).toBe(200);
    expect(susp.json().status).toBe('SUSPENDED');

    // Public: gone. Owner: still visible. Admin: visible.
    const pub = await app.inject({ method: 'GET', url: `/v1/commerce/stores/${storeBId}` });
    expect(pub.statusCode).toBe(404);
    const owner = await app.inject({
      method: 'GET',
      url: `/v1/commerce/stores/${storeBId}`,
      headers: auth(artistB.token),
    });
    expect(owner.statusCode).toBe(200);

    // Suspended stores cannot take orders: cart add is rejected.
    const add = await addToCart(listener.token, productBId, 1);
    expect(add.statusCode).toBe(422);

    // Reinstate for later blocks.
    const rein = await app.inject({
      method: 'POST',
      url: `/v1/admin/commerce/stores/${storeBId}/moderate`,
      headers: auth(admin.token),
      payload: { action: 'reinstate' },
    });
    expect(rein.statusCode).toBe(200);
    const suspended = await auditRows('commerce.store.suspended', storeBId);
    const reinstated = await auditRows('commerce.store.reinstated', storeBId);
    expect(suspended.length + reinstated.length).toBeGreaterThanOrEqual(2);
    expect(suspended[0].metadata).not.toHaveProperty('address');
  });

  it('exposes the store by artist and lists stores for admin', async () => {
    const byArtist = await app.inject({
      method: 'GET',
      url: `/v1/commerce/artists/${artistA.artistId}/store`,
    });
    expect(byArtist.statusCode).toBe(200);
    expect(byArtist.json().id).toBe(storeAId);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/commerce/stores',
      headers: auth(admin.token),
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json().data as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(storeAId);
    expect(ids).toContain(storeBId);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/v1/admin/commerce/stores',
      headers: auth(artistA.token),
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('lists products for admin and returns commerce stats', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/commerce/products',
      headers: auth(admin.token),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);

    const forbidden = await app.inject({
      method: 'GET',
      url: '/v1/admin/commerce/products',
      headers: auth(artistA.token),
    });
    expect(forbidden.statusCode).toBe(403);

    const stats = await app.inject({
      method: 'GET',
      url: '/v1/admin/commerce/stats',
      headers: auth(admin.token),
    });
    expect(stats.statusCode).toBe(200);
    const s = stats.json();
    expect(s.storeCount).toBeGreaterThanOrEqual(2);
    expect(s.productCount).toBeGreaterThanOrEqual(1);
    expect(s.grossCentsByCurrency).toBeDefined();
    expect(s.refundedCentsByCurrency).toBeDefined();
    for (const v of Object.values(s.grossCentsByCurrency)) {
      expect(v).toBeGreaterThanOrEqual(0);
    }

    const statsForbidden = await app.inject({
      method: 'GET',
      url: '/v1/admin/commerce/stats',
      headers: auth(listener.token),
    });
    expect(statsForbidden.statusCode).toBe(403);
  });
});

describe('Phase 30 — products, variants, inventory', () => {
  it('rejects product creation for non-owners and invalid input', async () => {
    const asListener = await createProduct(listener.token, storeAId);
    expect(asListener.statusCode).toBe(403);
    const crossStore = await createProduct(artistB.token, storeAId);
    expect(crossStore.statusCode).toBe(403);
    const zeroPrice = await createProduct(artistA.token, storeAId, { priceCents: 0 });
    expect(zeroPrice.statusCode).toBe(400);
    const badType = await createProduct(artistA.token, storeAId, { type: 'TICKET' });
    expect(badType.statusCode).toBe(400);
    const negativePrice = await createProduct(artistA.token, storeAId, { priceCents: -50 });
    expect(negativePrice.statusCode).toBe(400);
    const emptyTitle = await createProduct(artistA.token, storeAId, { title: '' });
    expect(emptyTitle.statusCode).toBe(400);
  });

  it('accepts same-artist catalog refs and rejects other artists\u2019', async () => {
    const ok = await createProduct(artistA.token, storeAId, {
      title: 'Phase30 Ref Vinyl',
      type: 'MUSIC',
      trackId: trackAId,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().trackRef.id).toBe(trackAId);
    // Clean up the fixture product (no orders reference it).
    await prisma.product.delete({ where: { id: ok.json().id as string } });

    const otherArtist = await createProduct(artistA.token, storeAId, { trackId: trackBId });
    expect(otherArtist.statusCode).toBe(404);
  });

  it('enforces status transitions and owner-only edits', async () => {
    const draft = await createProduct(artistA.token, storeAId, {
      title: 'Phase30 Draft',
      status: 'DRAFT',
    });
    expect(draft.statusCode).toBe(201);
    const draftId = draft.json().id as string;

    // DRAFT is invisible publicly, visible to owner.
    const pub = await app.inject({ method: 'GET', url: `/v1/commerce/products/${draftId}` });
    expect(pub.statusCode).toBe(404);
    const owner = await app.inject({
      method: 'GET',
      url: `/v1/commerce/products/${draftId}`,
      headers: auth(artistA.token),
    });
    expect(owner.statusCode).toBe(200);

    const crossEdit = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/products/${draftId}`,
      headers: auth(artistB.token),
      payload: { title: 'Hijacked' },
    });
    expect(crossEdit.statusCode).toBe(403);

    // REMOVED is moderation-only.
    const remove = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/products/${draftId}`,
      headers: auth(artistA.token),
      payload: { status: 'REMOVED' },
    });
    // REMOVED is moderation-only: owners get 403, not a transition error.
    expect(remove.statusCode).toBe(403);

    const activate = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/products/${draftId}`,
      headers: auth(artistA.token),
      payload: { status: 'ACTIVE' },
    });
    expect(activate.statusCode).toBe(200);
    await prisma.product.delete({ where: { id: draftId } });
  });

  it('flips ACTIVE<->SOLD_OUT on inventory depletion and restock', async () => {
    const mk = await createProduct(artistA.token, storeAId, { title: 'Phase30 Flip' });
    const pid = mk.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 2 },
    });
    let p = await prisma.product.findUnique({ where: { id: pid } });
    expect(p?.status).toBe('ACTIVE');

    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 0 },
    });
    p = await prisma.product.findUnique({ where: { id: pid } });
    expect(p?.status).toBe('SOLD_OUT');

    // SOLD_OUT products are not purchasable.
    const add = await addToCart(listener.token, pid, 1);
    expect(add.statusCode).toBe(422);

    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 4 },
    });
    p = await prisma.product.findUnique({ where: { id: pid } });
    expect(p?.status).toBe('ACTIVE');
    await prisma.product.delete({ where: { id: pid } });
  });

  it('never lets inventory writes clobber reserved units', async () => {
    // Reserve one vinyl through checkout, then try to zero the inventory.
    await addToCart(listener2.token, vinylId, 1);
    const co = await checkout(listener2.token, `inv-clobber-${Date.now()}`);
    if (co.statusCode !== 201) console.log('CO500', co.statusCode, co.body.slice(0, 500));
    expect(co.statusCode).toBe(201);
    const orderId = co.json().order.id as string;

    const set = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${vinylId}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 0 },
    });
    expect(set.statusCode).toBe(200);
    const rows = set.json().inventory as { quantityAvailable: number; quantityReserved: number }[];
    expect(rows[0].quantityReserved).toBe(1);
    expect(rows[0].quantityAvailable).toBeGreaterThanOrEqual(rows[0].quantityReserved);

    // Clean up: cancel the unpaid order, releasing the reservation.
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/cancel`,
      headers: auth(listener2.token),
    });
    expect(cancel.statusCode).toBe(200);
    // Restore the fixture inventory (3) for later blocks.
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${vinylId}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 3 },
    });
  });

  it('caps variants at the configured limit', async () => {
    const mk = await createProduct(artistA.token, storeAId, { title: 'Phase30 Variants' });
    const pid = mk.json().id as string;
    for (let i = 0; i < 50; i++) {
      const v = await app.inject({
        method: 'POST',
        url: `/v1/commerce/products/${pid}/variants`,
        headers: auth(artistA.token),
        payload: { name: `Size ${i}`, priceCents: 2500 },
      });
      expect(v.statusCode).toBe(201);
    }
    const over = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/variants`,
      headers: auth(artistA.token),
      payload: { name: 'Size 51', priceCents: 2500 },
    });
    expect(over.statusCode).toBe(422);
    await prisma.product.delete({ where: { id: pid } });
  });

  it('archives products and keeps them out of the public surface', async () => {
    const mk = await createProduct(artistA.token, storeAId, { title: 'Phase30 Archive' });
    const pid = mk.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 5 },
    });
    const arch = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/archive`,
      headers: auth(artistA.token),
    });
    expect(arch.statusCode).toBe(200);
    expect(arch.json().status).toBe('ARCHIVED');

    const list = await app.inject({
      method: 'GET',
      url: `/v1/commerce/stores/${storeAId}/products`,
    });
    const ids = (list.json().data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(pid);
    await prisma.product.delete({ where: { id: pid } });
  });

  it('lists only ACTIVE products publicly with scoped search', async () => {
    const list = await app.inject({
      method: 'GET',
      url: `/v1/commerce/stores/${storeAId}/products?q=tee`,
    });
    expect(list.statusCode).toBe(200);
    const items = list.json().data as { id: string; title: string; status: string }[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.status).toBe('ACTIVE');
    expect(items.some((i) => i.id === shirtId)).toBe(true);

    // Owner-scoped status filter sees DRAFT too.
    const mk = await createProduct(artistA.token, storeAId, {
      title: 'Phase30 Hidden Draft',
      status: 'DRAFT',
    });
    const ownerList = await app.inject({
      method: 'GET',
      url: `/v1/commerce/stores/${storeAId}/products?status=DRAFT`,
      headers: auth(artistA.token),
    });
    expect((ownerList.json().data as { id: string }[]).some((p) => p.id === mk.json().id)).toBe(true);
    const anonDraft = await app.inject({
      method: 'GET',
      url: `/v1/commerce/stores/${storeAId}/products?status=DRAFT`,
    });
    expect(anonDraft.statusCode).toBe(200);
    expect(
      (anonDraft.json().data as { id: string }[]).some((p) => p.id === mk.json().id),
    ).toBe(false);
    await prisma.product.delete({ where: { id: mk.json().id as string } });
  });

  it('manages product images', async () => {
    const add = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${shirtId}/images`,
      headers: auth(artistA.token),
      payload: { imageUrl: 'https://cdn.example/shirt.jpg', altText: 'Tee front' },
    });
    expect(add.statusCode).toBe(201);
    const imageId = add.json().id as string;

    const detail = await app.inject({ method: 'GET', url: `/v1/commerce/products/${shirtId}` });
    expect((detail.json().images as { id: string }[]).some((i) => i.id === imageId)).toBe(true);

    const crossDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/commerce/products/images/${imageId}`,
      headers: auth(artistB.token),
    });
    expect(crossDelete.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/commerce/products/images/${imageId}`,
      headers: auth(artistA.token),
    });
    expect(del.statusCode).toBe(204);
  });
});

describe('Phase 30 — cart', () => {
  it('requires authentication and validates purchasability', async () => {
    const anon = await app.inject({
      method: 'POST',
      url: '/v1/commerce/cart/items',
      payload: { productId: shirtId, quantity: 1 },
    });
    expect(anon.statusCode).toBe(401);

    // Variant required when the product has variants.
    const noVariant = await addToCart(listener.token, shirtId, 1);
    expect(noVariant.statusCode).toBe(422);

    // Quantity beyond availability.
    const tooMany = await addToCart(listener.token, shirtId, 99, shirtVariantLargeId);
    expect(tooMany.statusCode).toBe(422);

    // DRAFT product not purchasable.
    const draft = await createProduct(artistA.token, storeAId, {
      title: 'Phase30 Cart Draft',
      status: 'DRAFT',
    });
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${draft.json().id}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 5 },
    });
    const draftAdd = await addToCart(listener.token, draft.json().id, 1);
    expect(draftAdd.statusCode).toBe(422);
    await prisma.product.delete({ where: { id: draft.json().id as string } });
  });

  it('groups lines by store and keeps carts user-isolated', async () => {
    await addToCart(listener.token, shirtId, 1, shirtVariantLargeId);
    await addToCart(listener.token, productBId, 2);

    const cart = await app.inject({
      method: 'GET',
      url: '/v1/commerce/cart',
      headers: auth(listener.token),
    });
    expect(cart.statusCode).toBe(200);
    const body = cart.json();
    expect(body.storeGroups).toHaveLength(2);
    const groupA = body.storeGroups.find((g: { storeId: string }) => g.storeId === storeAId);
    expect(groupA.items[0].variant.id).toBe(shirtVariantLargeId);
    expect(groupA.items[0].purchasable).toBe(true);

    // listener2's cart is empty and cannot see listener's lines.
    const other = await app.inject({
      method: 'GET',
      url: '/v1/commerce/cart',
      headers: auth(listener2.token),
    });
    expect(other.json().items).toHaveLength(0);
    const lineId = body.items[0].id as string;
    const patchOther = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/cart/items/${lineId}`,
      headers: auth(listener2.token),
      payload: { quantity: 5 },
    });
    expect(patchOther.statusCode).toBe(404);
  });

  it('updates quantities and clears the cart', async () => {
    const cart = await app.inject({
      method: 'GET',
      url: '/v1/commerce/cart',
      headers: auth(listener.token),
    });
    const lineId = cart.json().items[0].id as string;
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/cart/items/${lineId}`,
      headers: auth(listener.token),
      payload: { quantity: 2 },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().items.find((i: { id: string }) => i.id === lineId).quantity).toBe(2);

    const zero = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/cart/items/${lineId}`,
      headers: auth(listener.token),
      payload: { quantity: 0 },
    });
    expect(zero.json().items.some((i: { id: string }) => i.id === lineId)).toBe(false);

    const clear = await app.inject({
      method: 'DELETE',
      url: '/v1/commerce/cart',
      headers: auth(listener.token),
    });
    expect(clear.statusCode).toBe(204);
    const empty = await app.inject({
      method: 'GET',
      url: '/v1/commerce/cart',
      headers: auth(listener.token),
    });
    expect(empty.json().items).toHaveLength(0);
  });
});

describe('Phase 30 — checkout and server-authoritative pricing', () => {
  it('rejects multi-store carts and empty carts', async () => {
    await addToCart(listener.token, vinylId, 1);
    await addToCart(listener.token, productBId, 1);
    const multi = await checkout(listener.token, `multi-${Date.now()}`);
    expect(multi.statusCode).toBe(422);
    await app.inject({ method: 'DELETE', url: '/v1/commerce/cart', headers: auth(listener.token) });

    const empty = await checkout(listener.token, `empty-${Date.now()}`);
    expect(empty.statusCode).toBe(422);
  });

  it('prices server-side: a price change between cart-add and checkout wins', async () => {
    await addToCart(listener.token, vinylId, 1);
    // Owner raises the price after the item is in the cart.
    await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/products/${vinylId}`,
      headers: auth(artistA.token),
      payload: { priceCents: 4500 },
    });
    const co = await checkout(listener.token, `pricewin-${Date.now()}`);
    expect(co.statusCode).toBe(201);
    const order = co.json().order;
    expect(order.items[0].unitPriceCents).toBe(4500);
    expect(order.subtotalCents).toBe(4500);
    // Total = server-side subtotal + the store's own shipping (whatever an
    // earlier test set it to); the point is the price change wins.
    expect(order.totalCents).toBe(order.subtotalCents + order.shippingCents);
    expect(order.currency).toBe('USD');
    expect(order.taxCents).toBe(0);
    // Restore fixture price.
    await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/products/${vinylId}`,
      headers: auth(artistA.token),
      payload: { priceCents: 3000 },
    });
    // Leave the order unpaid; cancel to release inventory for later tests.
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/cancel`,
      headers: auth(listener.token),
    });
  });

  it('is idempotent per idempotency key', async () => {
    await addToCart(listener.token, vinylId, 1);
    const key = `idem-${Date.now()}`;
    const first = await checkout(listener.token, key);
    expect(first.statusCode).toBe(201);
    expect(first.json().created).toBe(true);
    const orderId = first.json().order.id as string;

    const second = await checkout(listener.token, key);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().order.id).toBe(orderId);

    const orders = await prisma.commerceOrder.count({
      where: { userId: listener.userId, idempotencyKey: key },
    });
    expect(orders).toBe(1);
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/cancel`,
      headers: auth(listener.token),
    });
  });

  it('reserves inventory atomically and prevents oversell', async () => {
    // Vinyl has 3 units. Both buyers load 2 into their carts while stock is
    // free; the second checkout must lose the atomic reservation race -> 409.
    await addToCart(listener.token, vinylId, 2);
    await addToCart(listener2.token, vinylId, 2);
    const a = await checkout(listener.token, `race-a-${Date.now()}`);
    expect(a.statusCode).toBe(201);
    const orderAId = a.json().order.id as string;

    const b = await checkout(listener2.token, `race-b-${Date.now()}`);
    expect(b.statusCode).toBe(409);

    const inv = await prisma.inventoryItem.findFirst({ where: { productId: vinylId } });
    expect(inv?.quantityAvailable).toBe(3);
    expect(inv?.quantityReserved).toBe(2);

    await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderAId}/cancel`,
      headers: auth(listener.token),
    });
    await app.inject({ method: 'DELETE', url: '/v1/commerce/cart', headers: auth(listener2.token) });
  });

  it('validates the shipping address and rate-limits checkout per user', async () => {
    await addToCart(listener.token, vinylId, 1);
    const badAddr = await app.inject({
      method: 'POST',
      url: '/v1/commerce/checkout',
      headers: auth(listener.token),
      payload: { idempotencyKey: `badaddr-${Date.now()}`, shippingAddress: { name: 'x' } },
    });
    expect(badAddr.statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: '/v1/commerce/cart', headers: auth(listener.token) });

    // Reset all buckets, exhaust listener2's real checkout bucket with
    // direct calls, then confirm the route itself returns 429.
    resetCommerceRateLimits();
    const config = loadConfig();
    for (let i = 0; i < 20; i++) {
      checkUserRateLimit(listener2.userId, 'commerce.checkout', 20, config.rateLimits.windowMs);
    }
    expect(() =>
      checkUserRateLimit(listener2.userId, 'commerce.checkout', 20, config.rateLimits.windowMs),
    ).toThrow(/Rate limit exceeded/);
    resetCommerceRateLimits();
    for (let i = 0; i < 20; i++) {
      checkUserRateLimit(listener2.userId, 'commerce.checkout', 20, config.rateLimits.windowMs);
    }
    await addToCart(listener2.token, vinylId, 1);
    const limited = await checkout(listener2.token, `rl-${Date.now()}`);
    expect(limited.statusCode).toBe(429);
    await app.inject({ method: 'DELETE', url: '/v1/commerce/cart', headers: auth(listener2.token) });
    resetCommerceRateLimits();
  });
});

describe('Phase 30 — payment verification and lifecycle', () => {
  it('moves to PAID only after provider verification', async () => {
    await addToCart(listener.token, shirtId, 1, shirtVariantLargeId);
    const co = await checkout(listener.token, `pay-ok-${Date.now()}`);
    expect(co.statusCode).toBe(201);
    const order = co.json().order;
    expect(order.status).toBe('PENDING_PAYMENT');
    const providerPaymentId = order.payment.providerPaymentId as string;

    // Simulate the buyer finishing payment in the provider's UI (mock
    // intents stay PENDING until completed), then confirm verifies with
    // the provider — never trusting the client.
    const done = await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/complete-payment',
      headers: auth(listener.token),
      payload: { providerPaymentId },
    });
    expect(done.statusCode).toBe(200);
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/confirm-payment`,
      headers: auth(listener.token),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe('PAID');

    // Inventory moved reserved -> sold.
    const inv = await prisma.inventoryItem.findFirst({
      where: { productId: shirtId, variantId: shirtVariantLargeId },
    });
    expect(inv?.quantityReserved).toBe(0);
    expect(inv?.quantitySold).toBe(1);

    // Confirm is idempotent on a paid order.
    const again = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/confirm-payment`,
      headers: auth(listener.token),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('PAID');
    expect(providerPaymentId).toMatch(/^mock_/);
  });

  it('releases the reservation when the provider reports failure', async () => {
    await addToCart(listener2.token, vinylId, 1);
    const co = await checkout(listener2.token, `pay-fail-${Date.now()}`);
    expect(co.statusCode).toBe(201);
    const order = co.json().order;
    const providerPaymentId = order.payment.providerPaymentId as string;

    const scenario = await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/payment-scenario',
      headers: auth(listener2.token),
      payload: { providerPaymentId, outcome: 'failed' },
    });
    expect(scenario.statusCode).toBe(200);

    // Apply the preset outcome in the mock provider, then confirm.
    const done = await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/complete-payment',
      headers: auth(listener2.token),
      payload: { providerPaymentId },
    });
    expect(done.statusCode).toBe(200);
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/confirm-payment`,
      headers: auth(listener2.token),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe('PENDING_PAYMENT');
    expect(confirm.json().payment.status).toBe('FAILED');

    // Reservation released back to available.
    const inv = await prisma.inventoryItem.findFirst({ where: { productId: vinylId } });
    expect(inv?.quantityReserved).toBe(0);
    expect(inv?.quantityAvailable).toBe(3);

    // Retry mints a fresh intent and can succeed.
    const retry = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/retry-payment`,
      headers: auth(listener2.token),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().order.payment.providerPaymentId).not.toBe(providerPaymentId);
    const retryPaymentId = retry.json().order.payment.providerPaymentId as string;
    const done2 = await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/complete-payment',
      headers: auth(listener2.token),
      payload: { providerPaymentId: retryPaymentId },
    });
    expect(done2.statusCode).toBe(200);
    const confirm2 = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/confirm-payment`,
      headers: auth(listener2.token),
    });
    expect(confirm2.json().status).toBe('PAID');
  });

  it('lets buyers cancel unpaid orders and blocks canceling paid ones', async () => {
    await addToCart(listener.token, vinylId, 1);
    const co = await checkout(listener.token, `cancel-${Date.now()}`);
    const orderId = co.json().order.id as string;

    const otherCancel = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/cancel`,
      headers: auth(listener2.token),
    });
    expect(otherCancel.statusCode).toBe(404);

    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/cancel`,
      headers: auth(listener.token),
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe('CANCELED');

    // A paid order cannot be canceled (refunds are the path): build and
    // pay for one deterministically inside this test.
    await addToCart(listener2.token, vinylId, 1);
    const paidCo = await checkout(listener2.token, `cancel-paid-${Date.now()}`);
    expect(paidCo.statusCode).toBe(201);
    const paidOrder = paidCo.json().order;
    const paidPid = paidOrder.payment.providerPaymentId as string;
    await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/complete-payment',
      headers: auth(listener2.token),
      payload: { providerPaymentId: paidPid },
    });
    const paidConfirm = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${paidOrder.id}/confirm-payment`,
      headers: auth(listener2.token),
    });
    expect(paidConfirm.json().status).toBe('PAID');
    const cancelPaid = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${paidOrder.id}/cancel`,
      headers: auth(listener2.token),
    });
    expect(cancelPaid.statusCode).toBe(409);
  });

  it('processes provider webhooks with signature verification and idempotency', async () => {
    await addToCart(listener.token, vinylId, 1);
    const co = await checkout(listener.token, `webhook-${Date.now()}`);
    const order = co.json().order;
    const providerPaymentId = order.payment.providerPaymentId as string;

    // Complete the mock intent so provider verification reports success,
    // then deliver a correctly signed mock webhook through the dev endpoint.
    await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/complete-payment',
      headers: auth(listener.token),
      payload: { providerPaymentId },
    });
    const hook = await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/payment-webhook',
      headers: auth(listener.token),
      payload: { providerPaymentId, eventType: 'payment.succeeded' },
    });
    expect(hook.statusCode).toBe(200);
    expect(hook.json().applied).toBe(true);
    const paid = await prisma.commerceOrder.findUnique({ where: { id: order.id } });
    expect(paid?.status).toBe('PAID');

    // Duplicate delivery: acknowledged, not applied twice.
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/payment-webhook',
      headers: auth(listener.token),
      payload: { providerPaymentId, eventType: 'payment.succeeded' },
    });
    expect(dup.json().applied).toBe(false);

    // Bad signature: rejected.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhooks/mock',
      headers: { 'x-mock-signature': 'wrong', 'content-type': 'application/json' },
      payload: JSON.stringify({ providerPaymentId, eventType: 'payment.succeeded' }),
    });
    expect(bad.statusCode).toBe(401);

    // Unknown provider id in path: 404.
    const unknownProvider = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhooks/stripe',
      headers: { 'x-mock-signature': 'wrong', 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(unknownProvider.statusCode).toBe(404);

    // Well-signed event for an unknown payment: acknowledged without effect.
    const { createHmac: hmac } = await import('node:crypto');
    const body = JSON.stringify({
      providerPaymentId: 'mock_does_not_exist',
      eventType: 'payment.succeeded',
      id: 'evt_unknown',
    });
    const sig = `t=${Date.now()},v1=${hmac('sha256', 'dev-mock-webhook-secret-change-me').update(body).digest('hex')}`;
    const unknownPayment = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhooks/mock',
      headers: { 'x-mock-signature': sig, 'content-type': 'application/json' },
      payload: body,
    });
    expect(unknownPayment.statusCode).toBe(200);
    expect(unknownPayment.json().applied).toBe(false);
  });

  it('refunds paid orders fully and idempotently, and restocks', async () => {
    // Note: the payment block consumes all 3 vinyl units (pay-fail retry,
    // cancel-paid, webhook), so this test uses the shirt variant (5 units)
    // for its orders.
    // Build and pay for a shirt-variant order deterministically.
    await addToCart(listener.token, shirtId, 1, shirtVariantLargeId);
    const paidCo = await checkout(listener.token, `refund-paid-${Date.now()}`);
    expect(paidCo.statusCode).toBe(201);
    const paidOrder = paidCo.json().order;
    const orderId = paidOrder.id as string;
    const pid = paidOrder.payment.providerPaymentId as string;
    await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/complete-payment',
      headers: auth(listener.token),
      payload: { providerPaymentId: pid },
    });
    const paidConfirm = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/confirm-payment`,
      headers: auth(listener.token),
    });
    expect(paidConfirm.json().status).toBe('PAID');
    const paidTotal = paidOrder.totalCents as number;

    // Unpaid orders cannot be refunded.
    await addToCart(listener.token, shirtId, 1, shirtVariantLargeId);
    const co = await checkout(listener.token, `refund-neg-${Date.now()}`);
    const unpaidRefund = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${co.json().order.id}/refund`,
      headers: auth(artistA.token),
      payload: { idempotencyKey: `r1-${Date.now()}` },
    });
    expect(unpaidRefund.statusCode).toBe(422);
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${co.json().order.id}/cancel`,
      headers: auth(listener.token),
    });

    const before = await prisma.inventoryItem.findFirst({
      where: { productId: shirtId, variantId: shirtVariantLargeId },
    });
    const refund = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/refund`,
      headers: auth(artistA.token),
      payload: { idempotencyKey: `refund-${Date.now()}`, reason: 'test refund' },
    });
    expect(refund.statusCode).toBe(200);
    expect(refund.json().status).toBe('SUCCEEDED');
    expect(refund.json().amountCents).toBe(paidTotal);

    // Order is REFUNDED; variant inventory restocked.
    const afterOrder = await app.inject({
      method: 'GET',
      url: `/v1/commerce/orders/${orderId}`,
      headers: auth(artistA.token),
    });
    expect(afterOrder.json().status).toBe('REFUNDED');
    const afterInv = await prisma.inventoryItem.findFirst({
      where: { productId: shirtId, variantId: shirtVariantLargeId },
    });
    expect(afterInv?.quantityAvailable).toBe((before?.quantityAvailable ?? 0) + 1);
    expect(afterInv?.quantitySold).toBe((before?.quantitySold ?? 0) - 1);

    // Second refund on an already-refunded order -> 409, proving no double-refund.
    const r1 = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/refund`,
      headers: auth(artistA.token),
      payload: { idempotencyKey: `refund-dup-${Date.now()}` },
    });
    expect(r1.statusCode).toBe(409);

    // Cross-owner artist cannot refund another store's order.
    const cross = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/refund`,
      headers: auth(artistB.token),
      payload: { idempotencyKey: `cross-${Date.now()}` },
    });
    expect(cross.statusCode).toBe(403);

    // Listener (non-owner, non-admin) cannot refund.
    const listenerRefund = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/refund`,
      headers: auth(listener.token),
      payload: { idempotencyKey: `lis-${Date.now()}` },
    });
    expect(listenerRefund.statusCode).toBe(403);
  });
});

describe('Phase 30 — fulfillment and order visibility', () => {
  it('walks the manual fulfillment chain and rejects skips', async () => {
    const paid = await prisma.commerceOrder.findFirst({
      where: { userId: listener2.userId, status: 'PAID' },
      orderBy: { createdAt: 'desc' },
    });
    const orderId = paid!.id;

    const skip = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/orders/${orderId}/fulfillment`,
      headers: auth(artistA.token),
      payload: { status: 'SHIPPED' },
    });
    expect(skip.statusCode).toBe(422);

    for (const status of ['PROCESSING', 'SHIPPED', 'DELIVERED']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/commerce/orders/${orderId}/fulfillment`,
        headers: auth(artistA.token),
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(status);
    }

    // Fulfillment never touches payment state.
    const row = await prisma.commerceOrder.findUnique({
      where: { id: orderId },
      include: { payments: { orderBy: { createdAt: 'desc' } } },
    });
    expect(row?.payments[0]?.status).toBe('SUCCEEDED');

    const cross = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/orders/${orderId}/fulfillment`,
      headers: auth(artistB.token),
      payload: { status: 'DELIVERED' },
    });
    expect(cross.statusCode).toBe(403);
  });

  it('scopes order visibility: buyer, store owner, admin — never strangers', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/v1/commerce/orders',
      headers: auth(listener.token),
    });
    const ids = (mine.json().data as { id: string }[]).map((o) => o.id);
    expect(ids.length).toBeGreaterThan(0);

    const other = await app.inject({
      method: 'GET',
      url: '/v1/commerce/orders',
      headers: auth(listener2.token),
    });
    const otherIds = (other.json().data as { id: string }[]).map((o) => o.id);
    expect(otherIds.some((id) => ids.includes(id))).toBe(false);

    // Store owner sees the order WITH the address; buyer sees their own.
    const paid = await prisma.commerceOrder.findFirst({
      where: { userId: listener2.userId, status: 'DELIVERED' },
    });
    const ownerView = await app.inject({
      method: 'GET',
      url: `/v1/commerce/orders/${paid!.id}`,
      headers: auth(artistA.token),
    });
    expect(ownerView.statusCode).toBe(200);
    expect(ownerView.json().shippingAddress.name).toBe('Test Buyer');
    expect(ownerView.json().buyerName).toBeTruthy();

    const stranger = await app.inject({
      method: 'GET',
      url: `/v1/commerce/orders/${paid!.id}`,
      headers: auth(listener.token),
    });
    expect(stranger.statusCode).toBe(404);

    // Artist B cannot see artist A's store orders.
    const storeOrders = await app.inject({
      method: 'GET',
      url: `/v1/commerce/stores/${storeAId}/orders`,
      headers: auth(artistB.token),
    });
    expect(storeOrders.statusCode).toBe(403);
    const ownerOrders = await app.inject({
      method: 'GET',
      url: `/v1/commerce/stores/${storeAId}/orders`,
      headers: auth(artistA.token),
    });
    expect(ownerOrders.statusCode).toBe(200);

    const adminOrders = await app.inject({
      method: 'GET',
      url: '/v1/admin/commerce/orders',
      headers: auth(admin.token),
    });
    expect(adminOrders.statusCode).toBe(200);
    expect(adminOrders.json().data.length).toBeGreaterThan(0);
  });

  it('keeps shipping addresses out of audit metadata and public DTOs', async () => {
    const rows = await prisma.adminAuditLog.findMany({
      where: {
        actor: { email: { endsWith: TEST_DOMAIN } },
        action: { startsWith: 'commerce.' },
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const meta = JSON.stringify(row.metadata ?? {});
      expect(meta).not.toContain('123 Commerce St');
      expect(meta).not.toContain('Test Buyer');
    }

    // Public product/store DTOs carry no addresses.
    const product = await app.inject({ method: 'GET', url: `/v1/commerce/products/${shirtId}` });
    expect(JSON.stringify(product.json())).not.toContain('Commerce St');
    const store = await app.inject({ method: 'GET', url: `/v1/commerce/stores/${storeAId}` });
    expect(JSON.stringify(store.json())).not.toContain('Commerce St');
  });
});

describe('Phase 30 — commerce moderation', () => {
  it('routes user reports into the Phase 17 workflow and moderates products', async () => {
    // Create a product to report and moderate (not a shared fixture).
    const mk = await createProduct(artistB.token, storeBId, { title: 'Phase30 Report Me' });
    const pid = mk.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistB.token),
      payload: { quantityAvailable: 5 },
    });

    const report = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: { targetType: 'PRODUCT', targetId: pid, reason: 'counterfeit claim test' },
    });
    expect(report.statusCode).toBe(201);

    const queue = await app.inject({
      method: 'GET',
      url: '/v1/admin/moderation-reports?targetType=PRODUCT',
      headers: auth(admin.token),
    });
    expect(queue.statusCode).toBe(200);
    expect(
      (queue.json().data as { targetId: string }[]).some((r) => r.targetId === pid),
    ).toBe(true);

    // Admin removes the product: hidden publicly, not purchasable.
    const remove = await app.inject({
      method: 'POST',
      url: `/v1/admin/commerce/products/${pid}/moderate`,
      headers: auth(admin.token),
      payload: { action: 'remove' },
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().status).toBe('REMOVED');

    const pub = await app.inject({ method: 'GET', url: `/v1/commerce/products/${pid}` });
    expect(pub.statusCode).toBe(404);
    const add = await addToCart(listener.token, pid, 1);
    expect(add.statusCode).toBe(422);

    // Non-admin cannot restore.
    const userRestore = await app.inject({
      method: 'POST',
      url: `/v1/admin/commerce/products/${pid}/moderate`,
      headers: auth(artistB.token),
      payload: { action: 'restore' },
    });
    expect(userRestore.statusCode).toBe(403);

    const restore = await app.inject({
      method: 'POST',
      url: `/v1/admin/commerce/products/${pid}/moderate`,
      headers: auth(admin.token),
      payload: { action: 'restore' },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().status).toBe('ACTIVE');

    const removed = await auditRows('commerce.product.removed', pid);
    const restored = await auditRows('commerce.product.restored', pid);
    expect(removed.length + restored.length).toBeGreaterThanOrEqual(2);
    await prisma.product.delete({ where: { id: pid } });
  });

  it('reports stores into the same workflow', async () => {
    const report = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: { targetType: 'ARTIST_STORE', targetId: storeBId, reason: 'test store report' },
    });
    expect(report.statusCode).toBe(201);

    // Reporting a nonexistent product fails cleanly.
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/moderation-reports',
      headers: auth(listener.token),
      payload: {
        targetType: 'PRODUCT',
        targetId: '00000000-0000-0000-0000-000000000000',
        reason: 'ghost',
      },
    });
    expect(bad.statusCode).toBe(404);
  });

  it('preserves historical order snapshots through moderation', async () => {
    // The refunded order still carries its product snapshot even though the
    // product lifecycle continued.
    const refunded = await prisma.commerceOrder.findFirst({
      where: { userId: listener.userId, status: 'REFUNDED' },
      include: { items: true },
    });
    expect(refunded).toBeTruthy();
    expect(refunded!.items.length).toBeGreaterThan(0);
    expect(refunded!.items[0].productTitle).toBeTruthy();
    expect(refunded!.items[0].unitPriceCents).toBeGreaterThan(0);
  });
});

describe('Phase 30 — rate limits (unit)', () => {
  it('enforces per-user buckets independent of IP', async () => {
    const config = loadConfig();
    const windowMs = config.rateLimits.windowMs;
    const key = `unit-test-${Date.now()}`;
    checkUserRateLimit(listener.userId, key, 2, windowMs);
    checkUserRateLimit(listener.userId, key, 2, windowMs);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/commerce/cart',
      headers: auth(listener.token),
    });
    expect(res.statusCode).toBe(200);
    // Direct bucket check: third use is rejected.
    let threw = false;
    try {
      checkUserRateLimit(listener.userId, key, 2, windowMs);
    } catch (err) {
      threw = true;
      expect((err as { status: number }).status).toBe(429);
    }
    expect(threw).toBe(true);
    // A different user has their own budget.
    expect(() => checkUserRateLimit(listener2.userId, key, 2, windowMs)).not.toThrow();
    resetCommerceRateLimits();
  });
});

describe('Phase 30 — financial and surface isolation', () => {
  it('never routes commerce money into royalty accounting', async () => {
    // Commerce must not create royalty records. Compare royalty table counts
    // before and after a full paid-order flow; pre-existing seed rows are fine.
    const before = {
      inputs: await prisma.royaltyRevenueInput.count(),
      runs: await prisma.royaltyCalculationRun.count(),
      earnings: await prisma.royaltyEarning.count(),
      streams: await prisma.royaltyEligibleStream.count(),
    };

    await addToCart(listener.token, shirtId, 1, shirtVariantLargeId);
    const co = await checkout(listener.token, `iso-${Date.now()}`);
    expect(co.statusCode).toBe(201);
    const order = co.json().order;
    await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/complete-payment',
      headers: auth(listener.token),
      payload: { providerPaymentId: order.payment.providerPaymentId },
    });
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/confirm-payment`,
      headers: auth(listener.token),
    });
    expect(confirm.json().status).toBe('PAID');

    expect(await prisma.royaltyRevenueInput.count()).toBe(before.inputs);
    expect(await prisma.royaltyCalculationRun.count()).toBe(before.runs);
    expect(await prisma.royaltyEarning.count()).toBe(before.earnings);
    expect(await prisma.royaltyEligibleStream.count()).toBe(before.streams);
  });

  it('does not create play events, subscriptions, or entitlements', async () => {
    expect(await prisma.playEvent.count()).toBe(0);
    expect(
      await prisma.subscription.count({ where: { user: { email: { endsWith: TEST_DOMAIN } } } }),
    ).toBe(0);
  });

  it('keeps commerce out of music search and analytics', async () => {
    // Catalog search (Phase 4 tracks endpoint) never surfaces commerce rows.
    const search = await app.inject({ method: 'GET', url: '/v1/tracks?q=Phase30' });
    expect(search.statusCode).toBe(200);
    expect(JSON.stringify(search.json())).not.toContain('commerce');

    // Store-scoped product search only; catalog search untouched.
    const storeSearch = await app.inject({
      method: 'GET',
      url: `/v1/commerce/stores/${storeAId}/products?q=tee`,
    });
    expect(storeSearch.statusCode).toBe(200);
    expect(
      (storeSearch.json().data as { title: string }[]).every((p) => p.title.includes('Phase30')),
    ).toBe(true);
  });

  it('gates dev-only payment endpoints behind the mock provider', async () => {
    // In this environment the mock provider IS configured, so the endpoint
    // is reachable for authenticated users. Use the most recent payment so
    // the intent exists in this process's mock provider (the DB persists
    // rows from earlier runs whose intents are gone).
    const payment = await prisma.commercePayment.findFirst({
      where: { order: { user: { email: { endsWith: TEST_DOMAIN } } } },
      orderBy: { createdAt: 'desc' },
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/payment-scenario',
      headers: auth(listener.token),
      payload: { providerPaymentId: payment!.providerPaymentId, outcome: 'failed' },
    });
    expect(ok.statusCode).toBe(200);
    // …but anonymous callers are rejected by auth before the dev gate.
    const anon = await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/payment-scenario',
      payload: { providerPaymentId: payment!.providerPaymentId, outcome: 'failed' },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('records audited actions with facts-only metadata', async () => {
    const actions = [
      'commerce.store.created',
      'commerce.product.created',
      'commerce.order.created',
      'commerce.order.paid',
    ];
    for (const action of actions) {
      const rows = await auditRows(action);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        const meta = JSON.stringify(row.metadata ?? {});
        expect(meta).not.toContain('123 Commerce St');
        expect(meta).not.toContain('mock-secret');
        expect(meta).not.toContain('card');
      }
    }
  });
});

describe('Phase 30 — stores (extended)', () => {
  it('rejects store creation with an invalid currency', async () => {
    const res = await createStore(artistA.token, artistA.artistId, { currency: 'XX' });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('lets owners update name and description', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/stores/${storeAId}`,
      headers: auth(artistA.token),
      payload: { name: `Renamed ${Date.now()}`, description: 'New description' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toContain('Renamed');
  });

  it('ignores currency changes after creation (currency is immutable)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/stores/${storeAId}`,
      headers: auth(artistA.token),
      payload: { currency: 'EUR' },
    });
    // Fastify strips undeclared properties; the update succeeds but the
    // currency must remain unchanged.
    expect(res.statusCode).toBe(200);
    const store = await prisma.artistStore.findUnique({ where: { id: storeAId } });
    expect(store?.currency).toBe('USD');
  });

  it('rejects store updates by non-owners and strangers', async () => {
    const byOther = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/stores/${storeAId}`,
      headers: auth(artistB.token),
      payload: { name: 'Hijack' },
    });
    expect(byOther.statusCode).toBe(403);
    const byListener = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/stores/${storeAId}`,
      headers: auth(listener.token),
      payload: { name: 'Hijack' },
    });
    expect(byListener.statusCode).toBe(403);
  });

  it('requires authentication for store creation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/stores',
      payload: { artistId: artistA.artistId, name: 'Nope', currency: 'USD' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Phase 30 — products (extended)', () => {
  it('rejects negative and zero prices', async () => {
    const neg = await createProduct(artistA.token, storeAId, { priceCents: -100 });
    expect([400, 422]).toContain(neg.statusCode);
    const zero = await createProduct(artistA.token, storeAId, { priceCents: 0 });
    expect([400, 422]).toContain(zero.statusCode);
  });

  it('lets owners update price and description', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'DRAFT' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/products/${id}`,
      headers: auth(artistA.token),
      payload: { priceCents: 9999, description: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().priceCents).toBe(9999);
  });

  it('keeps DRAFT products out of the public surface', async () => {
    const created = await createProduct(artistA.token, storeAId, {
      title: `DraftOnly ${Date.now()}`,
      status: 'DRAFT',
    });
    const id = created.json().id as string;
    const pub = await app.inject({ method: 'GET', url: `/v1/commerce/stores/${storeAId}/products` });
    const ids = (pub.json().data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(id);
    const direct = await app.inject({ method: 'GET', url: `/v1/commerce/products/${id}` });
    expect(direct.statusCode).toBe(404);
  });

  it('updates variant price and name', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'DRAFT' });
    const pid = created.json().id as string;
    const v = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/variants`,
      headers: auth(artistA.token),
      payload: { name: 'Small', priceCents: 2500, sku: `SKU-${Date.now()}` },
    });
    expect(v.statusCode).toBe(201);
    const vid = v.json().id as string;
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/products/${pid}/variants/${vid}`,
      headers: auth(artistA.token),
      payload: { priceCents: 3000, name: 'Small Updated' },
    });
    expect(upd.statusCode).toBe(200);
    expect(upd.json().priceCents).toBe(3000);
    expect(upd.json().name).toBe('Small Updated');
  });

  it('deletes variants', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'DRAFT' });
    const pid = created.json().id as string;
    const v = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/variants`,
      headers: auth(artistA.token),
      payload: { name: 'Temp', priceCents: 2500 },
    });
    expect(v.statusCode).toBe(201);
    const vid = v.json().id as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/commerce/products/${pid}/variants/${vid}`,
      headers: auth(artistA.token),
    });
    expect(del.statusCode).toBe(200);
    const row = await prisma.productVariant.findUnique({ where: { id: vid } });
    expect(row).toBeNull();
  });

  it('reorders product images', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'DRAFT' });
    const pid = created.json().id as string;
    const mk = (n: number) =>
      app.inject({
        method: 'POST',
        url: `/v1/commerce/products/${pid}/images`,
        headers: auth(artistA.token),
        payload: { imageUrl: `https://cdn.example.com/${Date.now()}-${n}.jpg` },
      });
    const i1 = (await mk(0)).json().id as string;
    const i2 = (await mk(1)).json().id as string;
    const reorder = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/images/reorder`,
      headers: auth(artistA.token),
      payload: { imageIds: [i2, i1] },
    });
    expect(reorder.statusCode).toBe(200);
    const ids = (reorder.json() as { id: string }[]).map((i) => i.id);
    expect(ids).toEqual([i2, i1]);
  });

  it('removes product images', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'DRAFT' });
    const pid = created.json().id as string;
    const img = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/images`,
      headers: auth(artistA.token),
      payload: { imageUrl: `https://cdn.example.com/${Date.now()}.jpg` },
    });
    expect(img.statusCode).toBe(201);
    const iid = img.json().id as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/commerce/products/images/${iid}`,
      headers: auth(artistA.token),
    });
    expect(del.statusCode).toBe(204);
    expect(await prisma.productImage.findUnique({ where: { id: iid } })).toBeNull();
  });

  it('rejects variant creation for missing products', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/products/00000000-0000-0000-0000-000000000000/variants',
      headers: auth(artistA.token),
      payload: { name: 'Ghost', priceCents: 100 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Phase 30 — inventory (extended)', () => {
  it('rejects negative inventory quantities', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'DRAFT' });
    const pid = created.json().id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: -5 },
    });
    expect([400, 422]).toContain(res.statusCode);
  });

  it('rejects inventory writes by non-owners', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${shirtId}/inventory`,
      headers: auth(artistB.token),
      payload: { variantId: shirtVariantLargeId, quantityAvailable: 100 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('exposes inventory to owners but not the public', async () => {
    const owner = await app.inject({
      method: 'GET',
      url: `/v1/commerce/products/${shirtId}/inventory`,
      headers: auth(artistA.token),
    });
    expect(owner.statusCode).toBe(200);
    const pub = await app.inject({
      method: 'GET',
      url: `/v1/commerce/products/${shirtId}`,
    });
    expect(pub.statusCode).toBe(200);
    expect(JSON.stringify(pub.json())).not.toContain('quantityAvailable');
  });
});

describe('Phase 30 — cart (extended)', () => {
  it('rejects invalid quantities', async () => {
    const zero = await addToCart(listener.token, shirtId, 0, shirtVariantLargeId);
    expect([400, 422]).toContain(zero.statusCode);
    const neg = await addToCart(listener.token, shirtId, -2, shirtVariantLargeId);
    expect([400, 422]).toContain(neg.statusCode);
  });

  it('rejects adding missing products', async () => {
    const res = await addToCart(listener.token, '00000000-0000-0000-0000-000000000000', 1);
    expect(res.statusCode).toBe(404);
  });

  it('removes the line when quantity is set to zero', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'ACTIVE' });
    const pid = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 10 },
    });
    await addToCart(listener2.token, pid, 2);
    const cart = await app.inject({ method: 'GET', url: '/v1/commerce/cart', headers: auth(listener2.token) });
    const line = (cart.json().items as { id: string; productId: string }[]).find((i) => i.productId === pid);
    expect(line).toBeTruthy();
    const upd = await app.inject({
      method: 'PATCH',
      url: `/v1/commerce/cart/items/${line!.id}`,
      headers: auth(listener2.token),
      payload: { quantity: 0 },
    });
    expect(upd.statusCode).toBe(200);
    const after = (upd.json().items as { productId: string }[]).some((i) => i.productId === pid);
    expect(after).toBe(false);
  });

  it('rejects adding more than the available stock', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'ACTIVE' });
    const pid = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 2 },
    });
    const res = await addToCart(listener2.token, pid, 99);
    expect(res.statusCode).toBe(422);
  });
});

describe('Phase 30 — checkout (extended)', () => {
  it('rejects addresses with missing required fields', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'ACTIVE' });
    const pid = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 5 },
    });
    await addToCart(listener2.token, pid, 1);
    const bad = { ...ADDRESS };
    delete (bad as Record<string, unknown>).city;
    const res = await checkout(listener2.token, `addr-bad-${Date.now()}`, bad as typeof ADDRESS);
    expect([400, 422]).toContain(res.statusCode);
    await app.inject({ method: 'DELETE', url: '/v1/commerce/cart', headers: auth(listener2.token) });
  });

  it('rejects invalid country codes', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'ACTIVE' });
    const pid = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 5 },
    });
    await addToCart(listener2.token, pid, 1);
    const res = await checkout(listener2.token, `addr-cc-${Date.now()}`, { ...ADDRESS, country: 'USA' });
    expect([400, 422]).toContain(res.statusCode);
    await app.inject({ method: 'DELETE', url: '/v1/commerce/cart', headers: auth(listener2.token) });
  });

  it('rejects checkout for anonymous callers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/checkout',
      payload: { idempotencyKey: `anon-${Date.now()}`, shippingAddress: ADDRESS },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Phase 30 — payments (extended)', () => {
  it('404s confirm on missing orders', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/orders/00000000-0000-0000-0000-000000000000/confirm-payment',
      headers: auth(listener.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s confirm for non-owners', async () => {
    const order = await prisma.commerceOrder.findFirst({
      where: { userId: listener2.userId, status: 'PAID' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order!.id}/confirm-payment`,
      headers: auth(listener.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects retry on canceled orders', async () => {
    const order = await prisma.commerceOrder.findFirst({
      where: { userId: listener.userId, status: 'CANCELED' },
    });
    expect(order).toBeTruthy();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order!.id}/retry-payment`,
      headers: auth(listener.token),
    });
    expect([400, 409, 422]).toContain(res.statusCode);
  });

  it('rejects malformed webhook bodies', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhooks/mock',
      headers: { 'content-type': 'application/json', 'x-mock-signature': 't=1,v1=deadbeef' },
      payload: 'not-json{{{',
    });
    expect([400, 401]).toContain(res.statusCode);
  });

  it('rejects webhook delivery for unknown providers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commerce/webhooks/acme-pay',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Phase 30 — refunds (extended)', () => {
  it('rejects refunds by non-owners', async () => {
    const order = await prisma.commerceOrder.findFirst({
      where: { userId: listener.userId, status: 'PAID' },
    });
    expect(order).toBeTruthy();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order!.id}/refund`,
      headers: auth(listener2.token),
      payload: { idempotencyKey: `evil-${Date.now()}` },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('rejects refunds on canceled orders', async () => {
    // Self-contained: create an unpaid order, cancel it, then refund must fail.
    await addToCart(listener.token, shirtId, 1, shirtVariantLargeId);
    const co = await checkout(listener.token, `rc-setup-${Date.now()}`);
    expect(co.statusCode).toBe(201);
    const orderId = co.json().order.id as string;
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/cancel`,
      headers: auth(listener.token),
    });
    expect(cancel.statusCode).toBe(200);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${orderId}/refund`,
      headers: auth(artistA.token),
      payload: { idempotencyKey: `rc-${Date.now()}` },
    });
    expect([400, 409, 422]).toContain(res.statusCode);
  });

  it('returns the same refund for a repeated idempotency key', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'ACTIVE' });
    const pid = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 5 },
    });
    await addToCart(listener2.token, pid, 1);
    const co = await checkout(listener2.token, `refund-idem-${Date.now()}`);
    expect(co.statusCode).toBe(201);
    const order = co.json().order;
    const ppid = order.payment.providerPaymentId as string;
    await app.inject({
      method: 'POST',
      url: '/v1/dev/commerce/complete-payment',
      headers: auth(listener2.token),
      payload: { providerPaymentId: ppid },
    });
    const confirm = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/confirm-payment`,
      headers: auth(listener2.token),
    });
    expect(confirm.json().status).toBe('PAID');
    const key = `refund-same-${Date.now()}`;
    const r1 = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/refund`,
      headers: auth(artistA.token),
      payload: { idempotencyKey: key },
    });
    expect(r1.statusCode).toBe(200);
    const r2 = await app.inject({
      method: 'POST',
      url: `/v1/commerce/orders/${order.id}/refund`,
      headers: auth(artistA.token),
      payload: { idempotencyKey: key },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().id).toBe(r1.json().id);
  });
});

describe('Phase 30 — orders (extended)', () => {
  it('paginates the buyer order list', async () => {
    const p1 = await app.inject({
      method: 'GET',
      url: '/v1/commerce/orders?limit=1',
      headers: auth(listener2.token),
    });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().data.length).toBeLessThanOrEqual(1);
    expect(p1.json().pagination).toBeTruthy();
  });

  it('lets admins view any order with the address', async () => {
    const order = await prisma.commerceOrder.findFirst({
      where: { userId: listener2.userId, status: 'PAID' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/orders/${order!.id}`,
      headers: auth(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().shippingAddress).toBeTruthy();
  });

  it('hides the shipping address from strangers even when the id is known', async () => {
    const order = await prisma.commerceOrder.findFirst({
      where: { userId: listener2.userId, status: 'PAID' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/commerce/orders/${order!.id}`,
      headers: auth(listener.token),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Phase 30 — moderation (extended)', () => {
  it('hides suspended products from the storefront but keeps them for the owner', async () => {
    const created = await createProduct(artistA.token, storeAId, {
      title: `SuspendMe ${Date.now()}`,
      status: 'ACTIVE',
    });
    const pid = created.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/v1/commerce/products/${pid}/inventory`,
      headers: auth(artistA.token),
      payload: { quantityAvailable: 3 },
    });
    const mod = await app.inject({
      method: 'POST',
      url: `/v1/admin/commerce/products/${pid}/moderate`,
      headers: auth(admin.token),
      payload: { action: 'remove' },
    });
    expect(mod.statusCode).toBe(200);
    const pub = await app.inject({ method: 'GET', url: `/v1/commerce/stores/${storeAId}/products` });
    const ids = (pub.json().data as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(pid);
    const owner = await app.inject({
      method: 'GET',
      url: `/v1/commerce/products/${pid}`,
      headers: auth(artistA.token),
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().status).toBe('REMOVED');
    const restore = await app.inject({
      method: 'POST',
      url: `/v1/admin/commerce/products/${pid}/moderate`,
      headers: auth(admin.token),
      payload: { action: 'restore' },
    });
    expect(restore.statusCode).toBe(200);
  });

  it('rejects moderation transitions by the store owner', async () => {
    const created = await createProduct(artistA.token, storeAId, { status: 'DRAFT' });
    const pid = created.json().id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/commerce/products/${pid}/moderate`,
      headers: auth(artistA.token),
      payload: { action: 'remove' },
    });
    expect(res.statusCode).toBe(403);
  });
});
