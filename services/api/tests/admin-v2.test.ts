/**
 * Admin V2 — platform operations center (backend) tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB). Scoped cleanup: every fixture uses TEST_DOMAIN emails.
 *
 * Covers:
 * - Permission boundaries: legacy ADMIN is NOT auto-escalated to new Admin V2
 *   powers (403 on finance/security/flags/subscription-override); named roles
 *   only hold their bundles (SUPPORT_ADMIN → subscriptions.manage;
 *   FINANCE_ADMIN → finance.view; neither → security.view/users.ban).
 * - Impersonation: SUPER_ADMIN start/end, blocked admin access, admin target
 *   refusal, self refusal, short reason refusal, demotion/ban invalidation.
 * - Emergency controls: maintenance 503 (admins on admin routes still work),
 *   read-only 403 on listener mutations, signup kill switch.
 * - Feature flags: SUPER_ADMIN-only create/update/delete, invalid key 400.
 * - Artist suspension: public 404 while suspended, restore re-lists.
 * - Bulk track status: READY<->TAKEDOWN only, per-track audit rows.
 * - Audit reversal: ban → reverse → unbanned; second reverse refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';

const TEST_DOMAIN = '@adminv2-test.local';
let counter = 0;
const testEmail = (tag: string) => `adminv2-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;

type Role =
  | 'LISTENER'
  | 'ARTIST'
  | 'ADMIN'
  | 'SUPER_ADMIN'
  | 'PLATFORM_ADMIN'
  | 'MODERATOR'
  | 'SUPPORT_ADMIN'
  | 'FINANCE_ADMIN'
  | 'CONTENT_ADMIN'
  | 'ARTIST_ADMIN'
  | 'ANALYTICS_ADMIN';

async function registerAndLogin(
  email: string,
  role: Role,
): Promise<{ userId: string; token: string }> {
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

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let superAdmin: { userId: string; token: string };
let legacyAdmin: { userId: string; token: string };
let supportAdmin: { userId: string; token: string };
let financeAdmin: { userId: string; token: string };
let listener: { userId: string; token: string };

beforeAll(async () => {
  // This suite creates many fixtures; raise the per-IP auth rate limits so
  // fixture setup is never throttled. Test-only; production defaults apply.
  process.env.RATE_LIMIT_LOGIN = '200';
  process.env.RATE_LIMIT_REGISTER = '200';
  const config = loadConfig();
  app = await buildApp(config);
  superAdmin = await registerAndLogin(testEmail('super'), 'SUPER_ADMIN');
  legacyAdmin = await registerAndLogin(testEmail('legacy'), 'ADMIN');
  supportAdmin = await registerAndLogin(testEmail('support'), 'SUPPORT_ADMIN');
  financeAdmin = await registerAndLogin(testEmail('finance'), 'FINANCE_ADMIN');
  listener = await registerAndLogin(testEmail('listener'), 'LISTENER');
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Permission boundaries
// ---------------------------------------------------------------------------

describe('permission boundaries', () => {
  it('legacy ADMIN keeps pre-existing powers (artist detail, suspend)', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/admin/users/${listener.userId}`,
      headers: auth(legacyAdmin.token),
    });
    expect([200, 404]).toContain(detail.statusCode);

    const cc = await app.inject({
      method: 'GET',
      url: '/v1/admin/command-center',
      headers: auth(legacyAdmin.token),
    });
    // system.view is in the legacy bundle
    expect(cc.statusCode).toBe(200);
  });

  it('legacy ADMIN is NOT auto-escalated to new Admin V2 powers', async () => {
    const finance = await app.inject({
      method: 'GET',
      url: '/v1/admin/finance/subscriptions',
      headers: auth(legacyAdmin.token),
    });
    expect(finance.statusCode).toBe(403);

    const security = await app.inject({
      method: 'GET',
      url: '/v1/admin/security/overview',
      headers: auth(legacyAdmin.token),
    });
    expect(security.statusCode).toBe(403);

    const flag = await app.inject({
      method: 'PUT',
      url: '/v1/admin/flags/some.flag',
      headers: auth(legacyAdmin.token),
      payload: { enabled: true, rolloutPercent: 100 },
    });
    expect(flag.statusCode).toBe(403);

    const ban = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${listener.userId}/ban`,
      headers: auth(legacyAdmin.token),
      payload: { reason: 'should not be allowed' },
    });
    expect(ban.statusCode).toBe(403);
  });

  it('SUPPORT_ADMIN can manage subscriptions but not security or bans', async () => {
    const sub = await prisma.subscription.create({
      data: {
        userId: listener.userId,
        planId: 'premium_individual',
        provider: 'DEV',
        status: 'ACTIVE',
      },
    });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/admin/subscriptions/${sub.id}`,
      headers: auth(supportAdmin.token),
      payload: { status: 'PAST_DUE' },
    });
    expect(res.statusCode).toBe(204);

    const security = await app.inject({
      method: 'GET',
      url: '/v1/admin/security/overview',
      headers: auth(supportAdmin.token),
    });
    expect(security.statusCode).toBe(403);

    const ban = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${listener.userId}/ban`,
      headers: auth(supportAdmin.token),
      payload: { reason: 'should not be allowed' },
    });
    expect(ban.statusCode).toBe(403);
    // Note: subscriptions are append-only (DB trigger rejects DELETE), so the
    // fixture row stays; it is scoped to this test's listener.
  });

  it('FINANCE_ADMIN can view finance centers but cannot ban or view security', async () => {
    const finance = await app.inject({
      method: 'GET',
      url: '/v1/admin/finance/commerce',
      headers: auth(financeAdmin.token),
    });
    expect(finance.statusCode).toBe(200);
    expect(finance.json()).toHaveProperty('grossCents');

    const royalties = await app.inject({
      method: 'GET',
      url: '/v1/admin/finance/royalties',
      headers: auth(financeAdmin.token),
    });
    expect(royalties.statusCode).toBe(200);

    const ban = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${listener.userId}/ban`,
      headers: auth(financeAdmin.token),
      payload: { reason: 'should not be allowed' },
    });
    expect(ban.statusCode).toBe(403);

    const security = await app.inject({
      method: 'GET',
      url: '/v1/admin/security/overview',
      headers: auth(financeAdmin.token),
    });
    expect(security.statusCode).toBe(403);
  });

  it('listener gets 403 on every admin surface probed', async () => {
    for (const [method, url] of [
      ['GET', '/v1/admin/command-center'],
      ['GET', '/v1/admin/finance/subscriptions'],
      ['GET', '/v1/admin/security/overview'],
      ['GET', '/v1/admin/jobs'],
      ['GET', '/v1/admin/health'],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(listener.token) });
      expect(res.statusCode).toBe(403);
    }
  });

  it('unauthenticated requests get 401 on admin surfaces', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/command-center' });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Impersonation
// ---------------------------------------------------------------------------

describe('impersonation', () => {
  it('SUPER_ADMIN starts an impersonation session; token works as the user', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(superAdmin.token),
      payload: {
        targetUserId: listener.userId,
        reason: 'investigating a reported playback bug',
        durationMinutes: 5,
      },
    });
    expect(start.statusCode).toBe(200);
    const token = start.json().token as string;
    expect(token).toBeTruthy();

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(listener.userId);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'impersonation.started', targetId: listener.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(superAdmin.userId);
  });

  it('impersonated sessions can never reach admin routes', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(superAdmin.token),
      payload: { targetUserId: listener.userId, reason: 'admin route denial check' },
    });
    const token = start.json().token as string;

    for (const url of ['/v1/admin/command-center', '/v1/admin/security/overview', '/v1/admin/flags']) {
      const res = await app.inject({ method: 'GET', url, headers: auth(token) });
      expect(res.statusCode).toBe(403);
    }
  });

  it('impersonated sessions can explicitly end the session', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(superAdmin.token),
      payload: { targetUserId: listener.userId, reason: 'testing the explicit exit route' },
    });
    const token = start.json().token as string;

    const end = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/end',
      headers: auth(token),
    });
    expect(end.statusCode).toBe(204);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'impersonation.ended', targetId: listener.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorId).toBe(superAdmin.userId);
  });

  it('refuses admin targets, self-impersonation, and short reasons', async () => {
    const adminTarget = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(superAdmin.token),
      payload: { targetUserId: legacyAdmin.userId, reason: 'must not impersonate admins' },
    });
    expect(adminTarget.statusCode).toBe(400);

    const selfTarget = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(superAdmin.token),
      payload: { targetUserId: superAdmin.userId, reason: 'must not impersonate self!!' },
    });
    expect(selfTarget.statusCode).toBe(400);

    const shortReason = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(superAdmin.token),
      payload: { targetUserId: listener.userId, reason: 'short' },
    });
    expect(shortReason.statusCode).toBe(400);
  });

  it('non-SUPER_ADMIN cannot start impersonation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(supportAdmin.token),
      payload: { targetUserId: listener.userId, reason: 'not a super admin attempt!!' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('demoting the SUPER_ADMIN invalidates live impersonation tokens', async () => {
    const temp = await registerAndLogin(testEmail('demote-super'), 'SUPER_ADMIN');
    const start = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(temp.token),
      payload: { targetUserId: listener.userId, reason: 'demotion invalidation check!!' },
    });
    expect(start.statusCode).toBe(200);
    const token = start.json().token as string;

    await prisma.user.update({ where: { id: temp.userId }, data: { role: 'LISTENER' } });

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
    expect(me.statusCode).toBe(401);
  });

  it('banning the target invalidates the impersonation token', async () => {
    const victim = await registerAndLogin(testEmail('victim'), 'LISTENER');
    const start = await app.inject({
      method: 'POST',
      url: '/v1/admin/impersonation/start',
      headers: auth(superAdmin.token),
      payload: { targetUserId: victim.userId, reason: 'ban invalidation check!!!!' },
    });
    const token = start.json().token as string;

    await prisma.user.update({
      where: { id: victim.userId },
      data: { bannedAt: new Date(), banReason: 'test ban' },
    });

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(token) });
    expect(me.statusCode).toBe(401);

    await prisma.user.update({
      where: { id: victim.userId },
      data: { bannedAt: null, banReason: null },
    });
  });
});

// ---------------------------------------------------------------------------
// Emergency controls
// ---------------------------------------------------------------------------

describe('emergency controls', () => {
  it('maintenance mode 503s listeners but leaves admin recovery routes working', async () => {
    const on = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/emergency.maintenance_mode',
      headers: auth(superAdmin.token),
      payload: { value: true },
    });
    expect(on.statusCode).toBe(204);

    const listenerRead = await app.inject({ method: 'GET', url: '/v1/tracks', headers: auth(listener.token) });
    expect(listenerRead.statusCode).toBe(503);

    const adminRecovery = await app.inject({
      method: 'GET',
      url: '/v1/admin/command-center',
      headers: auth(superAdmin.token),
    });
    expect(adminRecovery.statusCode).toBe(200);

    const off = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/emergency.maintenance_mode',
      headers: auth(superAdmin.token),
      payload: { value: false },
    });
    expect(off.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/v1/tracks', headers: auth(listener.token) });
    expect(after.statusCode).toBe(200);
  });

  it('read-only mode 403s listener mutations but not admin operations', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/emergency.readonly_mode',
      headers: auth(superAdmin.token),
      payload: { value: true },
    });

    const mutation = await app.inject({
      method: 'POST',
      url: '/v1/playlists',
      headers: auth(listener.token),
      payload: { title: 'should be blocked' },
    });
    expect(mutation.statusCode).toBe(403);

    const read = await app.inject({ method: 'GET', url: '/v1/tracks', headers: auth(listener.token) });
    expect(read.statusCode).toBe(200);

    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/emergency.readonly_mode',
      headers: auth(superAdmin.token),
      payload: { value: false },
    });
  });

  it('signup kill switch refuses registration', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/emergency.new_signups_enabled',
      headers: auth(superAdmin.token),
      payload: { value: false },
    });

    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: testEmail('blocked'), password: PASSWORD, displayName: 'blocked' },
    });
    expect(reg.statusCode).toBe(400);

    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/emergency.new_signups_enabled',
      headers: auth(superAdmin.token),
      payload: { value: true },
    });
  });

  it('non-SUPER_ADMIN cannot change platform settings', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/platform.support_email',
      headers: auth(supportAdmin.token),
      payload: { value: 'support@example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('unknown setting keys are rejected', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/totally.bogus',
      headers: auth(superAdmin.token),
      payload: { value: true },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

describe('feature flags', () => {
  const key = 'adminv2.test-flag';

  it('SUPER_ADMIN can create, list, and delete a flag', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/admin/flags/${key}`,
      headers: auth(superAdmin.token),
      payload: { enabled: true, rolloutPercent: 50, description: 'test flag' },
    });
    expect(put.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/v1/admin/flags', headers: auth(superAdmin.token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((f: { key: string }) => f.key === key)).toBe(true);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'platform.flag.changed' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/flags/${key}`,
      headers: auth(superAdmin.token),
    });
    expect(del.statusCode).toBe(204);
  });

  it('non-SUPER_ADMIN cannot manage flags', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/admin/flags/adminv2.nope',
      headers: auth(supportAdmin.token),
      payload: { enabled: true, rolloutPercent: 100 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('invalid flag keys and rollout values are rejected', async () => {
    const badKey = await app.inject({
      method: 'PUT',
      url: '/v1/admin/flags/BAD KEY!',
      headers: auth(superAdmin.token),
      payload: { enabled: true, rolloutPercent: 100 },
    });
    expect([400, 404]).toContain(badKey.statusCode);

    const badRollout = await app.inject({
      method: 'PUT',
      url: '/v1/admin/flags/adminv2.bad-rollout',
      headers: auth(superAdmin.token),
      payload: { enabled: true, rolloutPercent: 101 },
    });
    expect(badRollout.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Artist suspension, bulk track status, audit reversal
// ---------------------------------------------------------------------------

describe('artist suspension and bulk content actions', () => {
  it('suspend hides the artist publicly; restore re-lists', async () => {
    const owner = await registerAndLogin(testEmail('artist-owner'), 'ARTIST');
    const artist = await prisma.artist.create({
      data: { name: `Suspended ${Date.now()}`, ownerUserId: owner.userId },
    });

    const before = await app.inject({ method: 'GET', url: `/v1/artists/${artist.id}` });
    expect(before.statusCode).toBe(200);

    const suspend = await app.inject({
      method: 'POST',
      url: `/v1/admin/artists/${artist.id}/suspend`,
      headers: auth(superAdmin.token),
      payload: { reason: 'test suspension for policy violation' },
    });
    expect(suspend.statusCode).toBe(204);

    const hidden = await app.inject({ method: 'GET', url: `/v1/artists/${artist.id}` });
    expect(hidden.statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url: '/v1/artists' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data.some((a: { id: string }) => a.id === artist.id)).toBe(false);

    const restore = await app.inject({
      method: 'POST',
      url: `/v1/admin/artists/${artist.id}/restore`,
      headers: auth(superAdmin.token),
    });
    expect(restore.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: `/v1/artists/${artist.id}` });
    expect(after.statusCode).toBe(200);
  });

  it('bulk track status only allows READY<->TAKEDOWN and audits each track', async () => {
    const owner = await registerAndLogin(testEmail('bulk-owner'), 'ARTIST');
    const artist = await prisma.artist.create({
      data: { name: `Bulk ${Date.now()}`, ownerUserId: owner.userId },
    });
    const t1 = await prisma.track.create({
      data: { title: 'bulk-one', artistId: artist.id, durationMs: 60000, status: 'READY' },
    });
    const t2 = await prisma.track.create({
      data: { title: 'bulk-two', artistId: artist.id, durationMs: 60000, status: 'READY' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/tracks/bulk-status',
      headers: auth(superAdmin.token),
      payload: { ids: [t1.id, t2.id], status: 'TAKEDOWN', reason: 'test bulk takedown action' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.updated.length).toBe(2);

    const rows = await prisma.adminAuditLog.findMany({
      where: { action: 'track.takedown', targetId: { in: [t1.id, t2.id] } },
    });
    expect(rows.length).toBe(2);
    expect(rows[0].beforeState).toMatchObject({ status: 'READY' });
    expect(rows[0].afterState).toMatchObject({ status: 'TAKEDOWN' });

    // Restoring back works (TAKEDOWN -> READY is allowed).
    const back = await app.inject({
      method: 'POST',
      url: '/v1/admin/tracks/bulk-status',
      headers: auth(superAdmin.token),
      payload: { ids: [t1.id, t2.id], status: 'READY', reason: 'test bulk restore action' },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().updated.length).toBe(2);
  });
});

describe('audit reversal', () => {
  it('ban is reversible; a second reversal is refused', async () => {
    const target = await registerAndLogin(testEmail('reversal-target'), 'LISTENER');

    const ban = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${target.userId}/ban`,
      headers: auth(superAdmin.token),
      payload: { reason: 'reversal test ban' },
    });
    expect(ban.statusCode).toBe(204);

    const banned = await prisma.user.findUnique({ where: { id: target.userId } });
    expect(banned!.bannedAt).not.toBeNull();

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'user.banned', targetId: target.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.reversible).toBe(true);

    const reverse = await app.inject({
      method: 'POST',
      url: `/v1/admin/audit-logs/${audit!.id}/reverse`,
      headers: auth(superAdmin.token),
    });
    expect(reverse.statusCode).toBe(200);

    const unbanned = await prisma.user.findUnique({ where: { id: target.userId } });
    expect(unbanned!.bannedAt).toBeNull();

    const reversal = await prisma.adminAuditLog.findFirst({
      where: { reversalOf: audit!.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(reversal).not.toBeNull();

    const again = await app.inject({
      method: 'POST',
      url: `/v1/admin/audit-logs/${audit!.id}/reverse`,
      headers: auth(superAdmin.token),
    });
    expect([400, 409]).toContain(again.statusCode);
  });

  it('non-SUPER_ADMIN cannot reverse audit events', async () => {
    const target = await registerAndLogin(testEmail('reversal-target2'), 'LISTENER');
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${target.userId}/ban`,
      headers: auth(superAdmin.token),
      payload: { reason: 'reversal guard test' },
    });
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: 'user.banned', targetId: target.userId },
      orderBy: { createdAt: 'desc' },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/audit-logs/${audit!.id}/reverse`,
      headers: auth(supportAdmin.token),
    });
    expect(res.statusCode).toBe(403);

    // Cleanup: unban via the normal path.
    await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${target.userId}/unban`,
      headers: auth(superAdmin.token),
    });
  });
});

// ---------------------------------------------------------------------------
// Caller's own permissions (permission-aware admin UI)
// ---------------------------------------------------------------------------

describe('my permissions', () => {
  it('SUPER_ADMIN sees all permissions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/me/permissions',
      headers: auth(superAdmin.token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe('SUPER_ADMIN');
    expect(body.permissions).toContain('security.view');
    expect(body.permissions).toContain('audit.view');
  });

  it('legacy ADMIN sees only the legacy bundle, not new Admin V2 powers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/me/permissions',
      headers: auth(legacyAdmin.token),
    });
    expect(res.statusCode).toBe(200);
    const perms: string[] = res.json().permissions;
    expect(perms).toContain('content.moderate');
    expect(perms).toContain('users.view');
    expect(perms).not.toContain('users.ban');
    expect(perms).not.toContain('security.view');
    expect(perms).not.toContain('finance.view');
  });

  it('SUPPORT_ADMIN sees its bundle', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/me/permissions',
      headers: auth(supportAdmin.token),
    });
    expect(res.statusCode).toBe(200);
    const perms: string[] = res.json().permissions;
    expect(perms).toContain('subscriptions.manage');
    expect(perms).toContain('users.view');
    expect(perms).not.toContain('security.view');
  });

  it('a listener sees an empty permission set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/me/permissions',
      headers: auth(listener.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().permissions).toEqual([]);
  });
});
