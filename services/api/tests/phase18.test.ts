/**
 * Phase 18 — subscriptions & entitlements tests. Full HTTP stack via
 * `app.inject()` against TEST_DATABASE_URL — never the dev DB.
 *
 * Covers:
 * - Entitlement state matrix: ACTIVE/TRIALING allow only inside their
 *   period window; PAST_DUE/CANCELED/EXPIRED/REVOKED/none deny.
 * - Period-boundary semantics: end is exclusive; missing period fails closed.
 * - Subscription lifecycle via the deterministic DEV adapter:
 *   start → renew → payment failed → recovered → canceled → expired.
 * - State machine: invalid transitions rejected (422), terminal states stuck.
 * - Idempotency: duplicate provider events write exactly one history row.
 * - Spoofing: client-supplied premium flags never influence the decision.
 * - Auth boundaries: unauthenticated 401; admin route 403 for non-admins.
 * - Dev endpoint 404s when DEV_SUBSCRIPTIONS_ENABLED is not set.
 * - Playback sessions are gated by the REAL entitlement service (no mocks
 *   in this file): entitled → 201, denied → 403 problem+json.
 *
 * Cleanup is scoped to `@phase18-test.local` addresses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SubscriptionStatus } from '@prisma/client';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { resolveEntitlement, getEntitlement } from '../src/modules/subscriptions/entitlements.js';
import { SUBSCRIPTION_TRANSITIONS } from '../src/modules/subscriptions/service.js';

const TEST_DOMAIN = '@phase18-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase18-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;

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
  await prisma.subscriptionEvent.deleteMany({ where: { subscription: userWhere } });
  await prisma.subscription.deleteMany({ where: userWhere });
  await prisma.refreshToken.deleteMany({ where: userWhere });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
}

interface TestSubscription {
  id: string;
  status: string;
  planId: string;
  provider: string;
  currentPeriodEnd: string | null;
  canceledAt: string | null;
  plan: { name: string };
}

interface TestEntitlement {
  entitled: boolean;
  status: string;
  reason: string;
  planCode: string | null;
}

interface DevEventResult {
  subscription: TestSubscription;
  entitlement: TestEntitlement;
  duplicate: boolean;
  title?: string;
  detail?: string;
  events?: Array<{ eventType: string }>;
}

/** Apply a deterministic DEV event for a user; returns the response body. */
async function devEvent(
  user: TestUser,
  body: Record<string, unknown>,
): Promise<{ status: number; body: DevEventResult }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/dev/subscription-events',
    headers: auth(user),
    payload: body,
  });
  return { status: res.statusCode, body: res.json() };
}

const period = (startIso: string, endIso: string) => ({
  periodStart: startIso,
  periodEnd: endIso,
});

beforeAll(async () => {
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    RATE_LIMIT_LOGIN: '1000',
    RATE_LIMIT_REGISTER: '1000',
    RATE_LIMIT_REFRESH: '1000',
    RATE_LIMIT_LOGOUT: '1000',
    RATE_LIMIT_API: '10000',
    DEV_SUBSCRIPTIONS_ENABLED: 'true',
  });
  app = await buildApp(config);
  await scopedClean();
});

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
});

// --- Pure entitlement decision matrix ----------------------------------------

describe('resolveEntitlement — state matrix', () => {
  const now = new Date('2026-09-21T12:00:00Z');
  const inWindow = {
    status: 'ACTIVE' as SubscriptionStatus,
    planId: 'premium_individual',
    currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
    currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
  };

  it('ACTIVE is entitled inside the paid period', () => {
    const r = resolveEntitlement(inWindow, now);
    expect(r.entitled).toBe(true);
    expect(r.status).toBe('ACTIVE');
    expect(r.reason).toBe('ok');
  });

  it('ACTIVE with no period fails closed', () => {
    const r = resolveEntitlement(
      {
        status: 'ACTIVE',
        planId: 'premium_individual',
        currentPeriodStart: null,
        currentPeriodEnd: null,
      },
      now,
    );
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe('access_period_ended');
  });

  it('ACTIVE is denied before the period starts', () => {
    const r = resolveEntitlement(
      {
        status: 'ACTIVE',
        planId: 'premium_individual',
        currentPeriodStart: new Date('2026-10-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
      },
      now,
    );
    expect(r.entitled).toBe(false);
  });

  it('ACTIVE is denied at/after the period end (boundary is exclusive)', () => {
    const end = new Date('2026-09-21T12:00:00Z');
    const r = resolveEntitlement(
      {
        status: 'ACTIVE',
        planId: 'premium_individual',
        currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
        currentPeriodEnd: end,
      },
      now,
    );
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe('access_period_ended');
  });

  it('TRIALING is entitled inside the trial window', () => {
    const r = resolveEntitlement({ ...inWindow, status: 'TRIALING' }, now);
    expect(r.entitled).toBe(true);
  });

  it('TRIALING is denied at/after the trial end (boundary is exclusive)', () => {
    const end = new Date('2026-09-21T12:00:00Z');
    const r = resolveEntitlement(
      {
        status: 'TRIALING',
        planId: 'premium_individual',
        currentPeriodStart: null,
        currentPeriodEnd: end,
      },
      now,
    );
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe('access_period_ended');
  });

  it('TRIALING with no trial end fails closed', () => {
    const r = resolveEntitlement(
      {
        status: 'TRIALING',
        planId: 'premium_individual',
        currentPeriodStart: null,
        currentPeriodEnd: null,
      },
      now,
    );
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe('access_period_ended');
  });

  it('PAST_DUE is denied immediately (fail-closed, no grace window)', () => {
    const r = resolveEntitlement({ ...inWindow, status: 'PAST_DUE' }, now);
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe('subscription_past_due');
  });

  it('CANCELED is denied immediately, even inside the paid period', () => {
    const r = resolveEntitlement({ ...inWindow, status: 'CANCELED' }, now);
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe('subscription_canceled');
  });

  it('EXPIRED is never entitled, even inside a nominal window', () => {
    const r = resolveEntitlement({ ...inWindow, status: 'EXPIRED' }, now);
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe('subscription_expired');
  });

  it('REVOKED is never entitled', () => {
    const r = resolveEntitlement({ ...inWindow, status: 'REVOKED' }, now);
    expect(r.entitled).toBe(false);
    expect(r.reason).toBe('subscription_revoked');
  });

  it('no subscription denies with NONE status', () => {
    const r = resolveEntitlement(null, now);
    expect(r.entitled).toBe(false);
    expect(r.status).toBe('NONE');
    expect(r.reason).toBe('no_subscription');
  });
});

// --- State machine ------------------------------------------------------------

describe('subscription state machine', () => {
  it('allows the documented lifecycle transitions', () => {
    expect(SUBSCRIPTION_TRANSITIONS.ACTIVE).toEqual(
      expect.arrayContaining(['PAST_DUE', 'CANCELED', 'EXPIRED', 'REVOKED']),
    );
    expect(SUBSCRIPTION_TRANSITIONS.TRIALING).toEqual(
      expect.arrayContaining(['ACTIVE', 'CANCELED']),
    );
    expect(SUBSCRIPTION_TRANSITIONS.PAST_DUE).toEqual(
      expect.arrayContaining(['ACTIVE', 'CANCELED', 'EXPIRED']),
    );
  });

  it('terminal states have no exits', () => {
    expect(SUBSCRIPTION_TRANSITIONS.EXPIRED).toEqual([]);
    expect(SUBSCRIPTION_TRANSITIONS.REVOKED).toEqual([]);
  });
});

// --- Dev adapter lifecycle -----------------------------------------------------

describe('DEV subscription lifecycle', () => {
  it('full lifecycle: start → renew → payment failed → recovered → canceled → expired', async () => {
    const user = await createUser('lifecycle');
    const ext = `dev-sub-${Date.now()}`;

    // Start
    let r = await devEvent(user, {
      providerEventId: `${ext}-start`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_individual',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    });
    expect(r.status).toBe(201);
    expect(r.body.subscription.status).toBe('ACTIVE');
    expect(r.body.subscription.planId).toBe('premium_individual');
    expect(r.body.subscription.provider).toBe('DEV');
    expect(r.body.entitlement.entitled).toBe(true);
    expect(r.body.duplicate).toBe(false);

    // Renew (stays ACTIVE)
    r = await devEvent(user, {
      providerEventId: `${ext}-renew`,
      eventType: 'RENEWAL_SUCCEEDED',
      externalSubscriptionId: ext,
      ...period('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    });
    expect(r.status).toBe(201);
    expect(r.body.subscription.status).toBe('ACTIVE');
    expect(r.body.subscription.currentPeriodEnd).toBe('2026-11-01T00:00:00.000Z');

    // Payment failed → PAST_DUE
    r = await devEvent(user, {
      providerEventId: `${ext}-fail`,
      eventType: 'PAYMENT_FAILED',
      externalSubscriptionId: ext,
    });
    expect(r.body.subscription.status).toBe('PAST_DUE');

    // Payment recovered → ACTIVE
    r = await devEvent(user, {
      providerEventId: `${ext}-recover`,
      eventType: 'PAYMENT_RECOVERED',
      externalSubscriptionId: ext,
    });
    expect(r.body.subscription.status).toBe('ACTIVE');

    // Canceled → CANCELED with canceledAt set
    r = await devEvent(user, {
      providerEventId: `${ext}-cancel`,
      eventType: 'SUBSCRIPTION_CANCELED',
      externalSubscriptionId: ext,
    });
    expect(r.body.subscription.status).toBe('CANCELED');
    expect(r.body.subscription.canceledAt).not.toBeNull();

    // Expired → EXPIRED (terminal)
    r = await devEvent(user, {
      providerEventId: `${ext}-expire`,
      eventType: 'SUBSCRIPTION_EXPIRED',
      externalSubscriptionId: ext,
    });
    expect(r.body.subscription.status).toBe('EXPIRED');
    expect(r.body.entitlement.entitled).toBe(false);
    expect(r.body.entitlement.reason).toBe('subscription_expired');
  });

  it('trial lifecycle: start trial → convert → active', async () => {
    const user = await createUser('trial');
    const ext = `dev-trial-${Date.now()}`;
    // Trial window straddles "now" so the trial is currently entitled.
    const trialStart = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const trialEnd = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString();
    const paidEnd = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

    let r = await devEvent(user, {
      providerEventId: `${ext}-start`,
      eventType: 'TRIAL_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_student',
      periodStart: trialStart,
      periodEnd: trialEnd,
    });
    expect(r.body.subscription.status).toBe('TRIALING');
    expect(r.body.subscription.planId).toBe('premium_student');
    expect(r.body.entitlement.entitled).toBe(true);

    r = await devEvent(user, {
      providerEventId: `${ext}-convert`,
      eventType: 'TRIAL_CONVERTED',
      externalSubscriptionId: ext,
      periodStart: new Date(Date.now() - 1000).toISOString(),
      periodEnd: paidEnd,
    });
    expect(r.body.subscription.status).toBe('ACTIVE');
    expect(r.body.entitlement.entitled).toBe(true);
  });

  it('rejects unknown plans (422)', async () => {
    const user = await createUser('badplan');
    const r = await devEvent(user, {
      providerEventId: `bad-${Date.now()}`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: `bad-${Date.now()}`,
      planCode: 'premium_enterprise',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    });
    expect(r.status).toBe(422);
    expect(r.body.title).toBe('Unprocessable Entity');
  });

  it('rejects payment-like fact keys (422)', async () => {
    const user = await createUser('badfacts');
    const r = await devEvent(user, {
      providerEventId: `bf-${Date.now()}`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: `bf-${Date.now()}`,
      planCode: 'premium_individual',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
      facts: { cardNumber: '4111111111111111' },
    });
    expect(r.status).toBe(422);
  });

  it('rejects start without planCode (422)', async () => {
    const user = await createUser('noplan');
    const r = await devEvent(user, {
      providerEventId: `np-${Date.now()}`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: `np-${Date.now()}`,
    });
    expect(r.status).toBe(422);
  });

  it('rejects invalid transitions: EXPIRED cannot become ACTIVE (422)', async () => {
    const user = await createUser('terminal');
    const ext = `dev-term-${Date.now()}`;
    await devEvent(user, {
      providerEventId: `${ext}-start`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_individual',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    });
    await devEvent(user, {
      providerEventId: `${ext}-expire`,
      eventType: 'SUBSCRIPTION_EXPIRED',
      externalSubscriptionId: ext,
    });
    const r = await devEvent(user, {
      providerEventId: `${ext}-resurrect`,
      eventType: 'RENEWAL_SUCCEEDED',
      externalSubscriptionId: ext,
    });
    expect(r.status).toBe(422);
    expect(r.body.detail).toMatch(/Invalid subscription transition/);
  });

  it('rejects non-creating events for unknown subscriptions (404)', async () => {
    const user = await createUser('ghost');
    const r = await devEvent(user, {
      providerEventId: `ghost-${Date.now()}`,
      eventType: 'RENEWAL_SUCCEEDED',
      externalSubscriptionId: `ghost-${Date.now()}`,
    });
    expect(r.status).toBe(404);
  });
});

// --- Idempotency ----------------------------------------------------------------

describe('event idempotency', () => {
  it('duplicate deliveries write exactly one history row and return duplicate:true', async () => {
    const user = await createUser('idem');
    const ext = `dev-idem-${Date.now()}`;
    const body = {
      providerEventId: `${ext}-start`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_family',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    };

    const first = await devEvent(user, body);
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);

    const second = await devEvent(user, body);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.subscription.id).toBe(first.body.subscription.id);

    // Exactly one event row for the provider event id.
    const count = await prisma.subscriptionEvent.count({
      where: { provider: 'DEV', providerEventId: `${ext}-start` },
    });
    expect(count).toBe(1);

    // History still reconstructs: one row total for this subscription.
    const history = await prisma.subscriptionEvent.count({
      where: { subscriptionId: first.body.subscription.id },
    });
    expect(history).toBe(1);
  });

  it('same providerEventId for a different event body is still a duplicate', async () => {
    const user = await createUser('idem2');
    const ext = `dev-idem2-${Date.now()}`;
    const first = await devEvent(user, {
      providerEventId: `${ext}-x`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_individual',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    });
    expect(first.body.duplicate).toBe(false);

    // Provider retried with different facts — same idempotency key wins.
    const second = await devEvent(user, {
      providerEventId: `${ext}-x`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_student',
      facts: { retry: 'true' },
    });
    expect(second.body.duplicate).toBe(true);
    expect(second.body.subscription.planId).toBe('premium_individual');
  });
});

// --- Spoofing --------------------------------------------------------------------

/** Write a minimal HLS package so session creation passes the asset check. */
async function writeHlsFixture(trackId: string): Promise<void> {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  const base = path.join(process.cwd(), 'storage', 'audio', 'tracks', trackId, 'hls');
  const rendition = path.join(base, '128k');
  await fs.mkdir(rendition, { recursive: true });
  await fs.writeFile(
    path.join(base, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\n128k/index.m3u8\n',
  );
  await fs.writeFile(
    path.join(rendition, 'index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg-00000.ts\n#EXT-X-ENDLIST\n',
  );
  await fs.writeFile(
    path.join(rendition, 'seg-00000.ts'),
    Buffer.from('0123456789ABCDEF'.repeat(64)),
  );
}

/** Create a READY track with HLS assets on disk for session-creation tests. */
async function createStreamableTrack(tag: string): Promise<{ trackId: string; artistId: string }> {
  const artist = await prisma.artist.create({ data: { name: `P18 Artist ${tag} ${Date.now()}` } });
  const track = await prisma.track.create({
    data: {
      title: `P18 Track ${tag} ${Date.now()}`,
      artistId: artist.id,
      durationMs: 180000,
      status: 'READY',
    },
  });
  await writeHlsFixture(track.id);
  return { trackId: track.id, artistId: artist.id };
}

async function deleteTrack(trackId: string, artistId: string): Promise<void> {
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');
  await prisma.track.delete({ where: { id: trackId } }).catch(() => {});
  await prisma.artist.delete({ where: { id: artistId } }).catch(() => {});
  await fs.rm(path.join(process.cwd(), 'storage', 'audio', 'tracks', trackId), {
    recursive: true,
    force: true,
  });
}

describe('client spoofing resistance', () => {
  it('ignores client-supplied premium flags: spoofed claims do not mint a session', async () => {
    const user = await createUser('spoof');
    const { trackId, artistId } = await createStreamableTrack('spoof');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/playback/sessions',
        headers: auth(user),
        payload: {
          trackId,
          premium: true,
          subscribed: true,
          isPremium: true,
          entitlement: { entitled: true },
        },
      });
      // The user has no subscription: spoofed flags must not help.
      expect(res.statusCode).toBe(403);
      expect(res.json().title).toBe('Subscription Required');
    } finally {
      await deleteTrack(trackId, artistId);
    }
  });

  it('a user with no subscription gets Subscription Required on playback sessions', async () => {
    const user = await createUser('nosub');
    const { trackId, artistId } = await createStreamableTrack('nosub');
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/playback/sessions',
        headers: auth(user),
        payload: { trackId },
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.title).toBe('Subscription Required');
      expect(body.type).toContain('subscription-required');
    } finally {
      await deleteTrack(trackId, artistId);
    }
  });

  it('entitled user CAN create a session; after revoke the same track 403s', async () => {
    const user = await createUser('revoke');
    const ext = `dev-revoke-${Date.now()}`;
    await devEvent(user, {
      providerEventId: `${ext}-start`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_individual',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    });

    const { trackId, artistId } = await createStreamableTrack('revoke');
    try {
      const sessionPayload = { trackId };

      // Entitled → session created.
      let res = await app.inject({
        method: 'POST',
        url: '/v1/playback/sessions',
        headers: auth(user),
        payload: sessionPayload,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().token).toBeTruthy();

      // Revoke → denied immediately (grace window rule does not apply to REVOKED).
      await devEvent(user, {
        providerEventId: `${ext}-revoke`,
        eventType: 'SUBSCRIPTION_REVOKED',
        externalSubscriptionId: ext,
      });

      res = await app.inject({
        method: 'POST',
        url: '/v1/playback/sessions',
        headers: auth(user),
        payload: sessionPayload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().title).toBe('Subscription Required');
    } finally {
      await deleteTrack(trackId, artistId);
    }
  });
});

// --- Current-user surface ---------------------------------------------------------

describe('GET /v1/subscriptions/me', () => {
  it('returns null subscription + NONE entitlement for a fresh user', async () => {
    const user = await createUser('me-fresh');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/me',
      headers: auth(user),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subscription).toBeNull();
    expect(body.entitlement.entitled).toBe(false);
    expect(body.entitlement.status).toBe('NONE');
  });

  it('returns the subscription with plan and entitlement after a DEV start', async () => {
    const user = await createUser('me-sub');
    const ext = `dev-me-${Date.now()}`;
    await devEvent(user, {
      providerEventId: `${ext}-start`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_family',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/me',
      headers: auth(user),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subscription.planId).toBe('premium_family');
    expect(body.subscription.plan.name).toBe('Premium Family');
    expect(body.subscription.provider).toBe('DEV');
    expect(body.entitlement.entitled).toBe(true);
    expect(body.entitlement.planCode).toBe('premium_family');
    // No external transaction details or secrets leak.
    expect(JSON.stringify(body)).not.toMatch(/secret|token|card/i);
  });

  it('requires authentication (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/subscriptions/me' });
    expect(res.statusCode).toBe(401);
  });

  it('lightweight entitlement endpoint works', async () => {
    const user = await createUser('me-ent');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/me/entitlement',
      headers: auth(user),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entitled).toBe(false);
  });
});

// --- Admin inspection ---------------------------------------------------------------

describe('GET /v1/admin/users/:id/subscription', () => {
  it('admin can inspect status, plan, provider, period, entitlement, history', async () => {
    const admin = await createUser('admin-insp');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    const target = await createUser('target-insp');
    const ext = `dev-admin-${Date.now()}`;
    await devEvent(target, {
      providerEventId: `${ext}-start`,
      eventType: 'SUBSCRIPTION_STARTED',
      externalSubscriptionId: ext,
      planCode: 'premium_student',
      ...period('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    });

    const adminLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: admin.email, password: PASSWORD },
    });
    const adminToken = adminLogin.json().tokens.accessToken as string;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/${target.id}/subscription`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subscription.status).toBe('ACTIVE');
    expect(body.subscription.planId).toBe('premium_student');
    expect(body.subscription.provider).toBe('DEV');
    expect(body.subscription.currentPeriodEnd).toBe('2026-10-01T00:00:00.000Z');
    expect(body.entitlement.entitled).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe('SUBSCRIPTION_STARTED');
  });

  it('non-admin gets 403', async () => {
    const user = await createUser('nonadmin');
    const target = await createUser('target2');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/${target.id}/subscription`,
      headers: auth(user),
    });
    expect(res.statusCode).toBe(403);
  });

  it('unknown user gets 404', async () => {
    const admin = await createUser('admin-404');
    await prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: admin.email, password: PASSWORD },
    });
    const adminToken = adminLogin.json().tokens.accessToken as string;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/users/00000000-0000-0000-0000-000000000000/subscription',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

// --- Dev endpoint gating -----------------------------------------------------------------

describe('dev endpoint gating', () => {
  it('returns 404 when DEV_SUBSCRIPTIONS_ENABLED is false', async () => {
    const closedConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DEV_SUBSCRIPTIONS_ENABLED: 'false',
      RATE_LIMIT_API: '10000',
    });
    const closedApp = await buildApp(closedConfig);
    try {
      const user = await createUser('gated');
      const res = await closedApp.inject({
        method: 'POST',
        url: '/v1/dev/subscription-events',
        headers: auth(user),
        payload: {
          providerEventId: 'x',
          eventType: 'SUBSCRIPTION_STARTED',
          externalSubscriptionId: 'x',
          planCode: 'premium_individual',
        },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await closedApp.close();
    }
  });

  it('refuses to boot in production with the dev flag set', () => {
    expect(() =>
      loadConfig({ ...process.env, NODE_ENV: 'production', DEV_SUBSCRIPTIONS_ENABLED: 'true' }),
    ).toThrow(/may only be true when NODE_ENV is development or test/);
  });

  it('refuses to boot in staging with the dev flag set', () => {
    expect(() =>
      loadConfig({ ...process.env, NODE_ENV: 'staging', DEV_SUBSCRIPTIONS_ENABLED: 'true' }),
    ).toThrow(/may only be true when NODE_ENV is development or test/);
  });
});

// --- getEntitlement integration ------------------------------------------------------------

describe('getEntitlement integration', () => {
  it('derives entitlement from the latest subscription row', async () => {
    const user = await createUser('latest');
    // Old expired row + new active row: latest wins.
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: 'premium_individual',
        provider: 'DEV',
        status: 'EXPIRED',
        externalSubscriptionId: `old-${Date.now()}`,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.subscription.create({
      data: {
        userId: user.id,
        planId: 'premium_family',
        provider: 'DEV',
        status: 'ACTIVE',
        externalSubscriptionId: `new-${Date.now()}`,
        currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
      },
    });

    const e = await getEntitlement(user.id, prisma);
    expect(e.entitled).toBe(true);
    expect(e.planCode).toBe('premium_family');
  });
});
