// Billing management: plan catalog, promo codes, purchase kill switch,
// and grace-period entitlements.
//
// Scope: the management layer added on top of the Phase 19 store
// verification. Permissions are Admin V2 `subscriptions.manage`
// (FINANCE_ADMIN); settings changes need SUPER_ADMIN.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/http/app.js';
import { prisma } from '../src/db.js';
import { getEntitlement } from '../src/modules/subscriptions/entitlements.js';

const TEST_DOMAIN = '@billing-test.local';
let counter = 0;
const testEmail = (tag: string) => `billing-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;

type Role = 'LISTENER' | 'SUPER_ADMIN' | 'FINANCE_ADMIN';

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
let financeAdmin: { userId: string; token: string };
let listener: { userId: string; token: string };

const planPayload = (tag: string) => ({
  id: `test_plan_${tag}`,
  name: `Test Plan ${tag}`,
  planType: 'INDIVIDUAL',
  priceCents: 999,
  currency: 'USD',
  billingInterval: 'MONTH',
  intervalCount: 1,
  trialDays: 7,
  features: ['Ad-free listening', 'Offline downloads'],
  sortOrder: 50,
  appleProductId: `dev.test.${tag}`,
  googleProductId: `test_${tag}`,
});

beforeAll(async () => {
  process.env.RATE_LIMIT_LOGIN = '200';
  process.env.RATE_LIMIT_REGISTER = '200';
  const config = loadConfig();
  app = await buildApp(config);
  // Remove fixtures from earlier runs of this suite (test ids are prefixed).
  const testPlans = await prisma.plan.findMany({
    where: { id: { startsWith: 'test_plan_' } },
    select: { id: true },
  });
  const testPlanIds = testPlans.map((p) => p.id);
  if (testPlanIds.length > 0) {
    await prisma.subscription.deleteMany({ where: { planId: { in: testPlanIds } } });
    await prisma.plan.deleteMany({ where: { id: { in: testPlanIds } } });
  }
  const testPromos = await prisma.promoCode.findMany({
    where: {
      code: {
        in: ['WELCOME20', 'ONCEONLY', 'TOGGLEME', 'KEEPME', 'DISPOSABLE'],
      },
    },
    select: { id: true },
  });
  const testPromoIds = testPromos.map((p) => p.id);
  if (testPromoIds.length > 0) {
    await prisma.promoRedemption.deleteMany({ where: { promoCodeId: { in: testPromoIds } } });
    await prisma.promoCode.deleteMany({ where: { id: { in: testPromoIds } } });
  }
  superAdmin = await registerAndLogin(testEmail('super'), 'SUPER_ADMIN');
  financeAdmin = await registerAndLogin(testEmail('finance'), 'FINANCE_ADMIN');
  listener = await registerAndLogin(testEmail('listener'), 'LISTENER');
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Plan catalog
// ---------------------------------------------------------------------------

describe('billing plans', () => {
  it('requires subscriptions.manage for the catalog', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/admin/billing/plans' });
    expect(anon.statusCode).toBe(401);
    const denied = await app.inject({
      method: 'GET',
      url: '/v1/admin/billing/plans',
      headers: auth(listener.token),
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
    });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json())).toBe(true);
  });

  it('creates a plan and lists it with paying-subscriber counts', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: planPayload('create'),
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.id).toBe('test_plan_create');
    expect(body.priceCents).toBe(999);
    expect(body.trialDays).toBe(7);
    expect(body.features).toEqual(['Ad-free listening', 'Offline downloads']);
    expect(body.payingSubscribers).toBe(0);

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
    });
    expect(listed.json().some((p: { id: string }) => p.id === 'test_plan_create')).toBe(true);
  });

  it('rejects invalid plan input', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: { ...planPayload('bad'), id: 'UPPERCASE BAD!', priceCents: -5 },
    });
    expect(bad.statusCode).toBe(400);

    const badCurrency = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: { ...planPayload('badcur'), currency: 'US' },
    });
    expect(badCurrency.statusCode).toBe(400);
  });

  it('rejects duplicate plan ids', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: planPayload('dup'),
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: planPayload('dup'),
    });
    expect(second.statusCode).toBe(409);
  });

  it('updates a plan partially', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: planPayload('patch'),
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/billing/plans/test_plan_patch',
      headers: auth(financeAdmin.token),
      payload: { priceCents: 1299, trialDays: 14 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().priceCents).toBe(1299);
    expect(patched.json().trialDays).toBe(14);
    expect(patched.json().name).toBe('Test Plan patch');
  });

  it('refuses to deactivate a plan with paying subscribers', async () => {
    const plan = planPayload('guard');
    await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: plan,
    });
    // Create an active subscription on the plan.
    await prisma.subscription.create({
      data: {
        userId: listener.userId,
        planId: plan.id,
        provider: 'DEV',
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        externalSubscriptionId: 'dev-test-sub',
      },
    });
    const deactivated = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans/test_plan_guard/deactivate',
      headers: auth(financeAdmin.token),
    });
    expect(deactivated.statusCode).toBe(409);
    // Cancel the subscription and the guard releases.
    await prisma.subscription.deleteMany({ where: { planId: 'test_plan_guard' } });
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans/test_plan_guard/deactivate',
      headers: auth(financeAdmin.token),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().active).toBe(false);
    // Reactivate works.
    const reactivated = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans/test_plan_guard/activate',
      headers: auth(financeAdmin.token),
    });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json().active).toBe(true);
  });

  it('audits plan mutations', async () => {
    const before = await prisma.adminAuditLog.count({
      where: { action: 'billing.plan.created' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: planPayload('audit'),
    });
    const after = await prisma.adminAuditLog.count({
      where: { action: 'billing.plan.created' },
    });
    expect(after).toBe(before + 1);
    const row = await prisma.adminAuditLog.findFirst({
      where: { action: 'billing.plan.created' },
      orderBy: { createdAt: 'desc' },
    });
    expect((row!.metadata as Record<string, unknown>).planId).toBe('test_plan_audit');
  });
});

// ---------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------

describe('billing promos', () => {
  it('creates a promo and rejects bad input', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: {
        code: 'WELCOME20',
        description: 'Welcome offer',
        percentOff: 20,
        maxRedemptions: 100,
        applicablePlans: ['test_plan_create'],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().code).toBe('WELCOME20');
    expect(created.json().percentOff).toBe(20);

    // Duplicate code.
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: { code: 'welcome20', percentOff: 10 },
    });
    expect(dup.statusCode).toBe(409);

    // Percent + amount is invalid.
    const both = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: { code: 'BADBOTH', percentOff: 10, amountOffCents: 500 },
    });
    expect(both.statusCode).toBe(400);

    // No discount at all is invalid.
    const none = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: { code: 'NODISCOUNT' },
    });
    expect(none.statusCode).toBe(400);

    // Expired-before-starts window is invalid.
    const window = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: {
        code: 'BADWINDOW',
        percentOff: 10,
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        expiresAt: new Date().toISOString(),
      },
    });
    expect(window.statusCode).toBe(400);
  });

  it('validates promo eligibility', async () => {
    // Inapplicable plan.
    const wrongPlan = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos/validate',
      headers: auth(financeAdmin.token),
      payload: { code: 'WELCOME20', userId: listener.userId, planId: 'test_plan_dup' },
    });
    expect(wrongPlan.statusCode).toBe(200);
    expect(wrongPlan.json().valid).toBe(false);
    expect(wrongPlan.json().reason).toMatch(/plan/i);

    // Applicable plan.
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos/validate',
      headers: auth(financeAdmin.token),
      payload: { code: 'WELCOME20', userId: listener.userId, planId: 'test_plan_create' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().valid).toBe(true);
  });

  it('enforces single redemption per user and usage caps', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: { code: 'ONCEONLY', percentOff: 50, maxRedemptions: 1 },
    });
    expect(created.statusCode).toBe(201);

    // First redemption records (counter is maintained alongside the ledger).
    const onceId = created.json().id as string;
    await prisma.promoRedemption.create({
      data: { promoCodeId: onceId, userId: listener.userId },
    });
    await prisma.promoCode.update({
      where: { id: onceId },
      data: { redeemedCount: { increment: 1 } },
    });
    // Cap reached for anyone else.
    const capped = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos/validate',
      headers: auth(financeAdmin.token),
      payload: { code: 'ONCEONLY', userId: superAdmin.userId },
    });
    expect(capped.json().valid).toBe(false);
    expect(capped.json().reason).toMatch(/fully_redeemed|limit/i);
  });

  it('deactivated promos stop validating', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: { code: 'TOGGLEME', percentOff: 15 },
    });
    const id = created.json().id as string;
    const deactivated = await app.inject({
      method: 'POST',
      url: `/v1/admin/billing/promos/${id}/deactivate`,
      headers: auth(financeAdmin.token),
    });
    expect(deactivated.statusCode).toBe(200);
    const validated = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos/validate',
      headers: auth(financeAdmin.token),
      payload: { code: 'TOGGLEME', userId: listener.userId },
    });
    expect(validated.json().valid).toBe(false);
    expect(validated.json().reason).toMatch(/inactive/i);
  });

  it('refuses to delete a redeemed promo', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: { code: 'KEEPME', percentOff: 25 },
    });
    const id = created.json().id as string;
    await prisma.promoRedemption.create({
      data: { promoCodeId: id, userId: listener.userId },
    });
    await prisma.promoCode.update({
      where: { id },
      data: { redeemedCount: { increment: 1 } },
    });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/billing/promos/${id}`,
      headers: auth(financeAdmin.token),
    });
    expect(deleted.statusCode).toBe(409);

    // An unredeemed promo deletes cleanly.
    const disposable = await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/promos',
      headers: auth(financeAdmin.token),
      payload: { code: 'DISPOSABLE', percentOff: 5 },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/admin/billing/promos/${disposable.json().id}`,
      headers: auth(financeAdmin.token),
    });
    expect(removed.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Kill switch and grace period
// ---------------------------------------------------------------------------

describe('billing controls', () => {
  it('kill switch blocks new purchases but keeps everything else alive', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/billing.subscriptions_enabled',
      headers: auth(superAdmin.token),
      payload: { value: false },
    });
    // New purchase verification is refused.
    const verify = await app.inject({
      method: 'POST',
      url: '/v1/subscriptions/verify-purchase',
      headers: auth(listener.token),
      payload: { provider: 'apple', purchaseToken: 'test-token' },
    });
    expect(verify.statusCode).toBe(503);
    // The products endpoint reports purchases as disabled.
    const products = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/products',
      headers: auth(listener.token),
    });
    expect(products.statusCode).toBe(200);
    expect(products.json().purchasesEnabled).toBe(false);
    // Re-enable.
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/billing.subscriptions_enabled',
      headers: auth(superAdmin.token),
      payload: { value: true },
    });
    const productsAgain = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/products',
      headers: auth(listener.token),
    });
    expect(productsAgain.json().purchasesEnabled).toBe(true);
  });

  it('grace period keeps past-due subscribers entitled briefly', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/billing.grace_period_days',
      headers: auth(superAdmin.token),
      payload: { value: 5 },
    });
    const plan = planPayload('grace');
    await app.inject({
      method: 'POST',
      url: '/v1/admin/billing/plans',
      headers: auth(financeAdmin.token),
      payload: plan,
    });
    const now = new Date();
    const userEmail = testEmail('graceuser');
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: userEmail, password: PASSWORD, displayName: userEmail },
    });
    const graceUserId = reg.json().user.id as string;

    // Past-due 2 days ago: inside the 5-day grace window.
    await prisma.subscription.create({
      data: {
        userId: graceUserId,
        planId: plan.id,
        provider: 'DEV',
        status: 'PAST_DUE',
        currentPeriodStart: new Date(now.getTime() - 40 * 86400000),
        currentPeriodEnd: new Date(now.getTime() - 2 * 86400000),
        externalSubscriptionId: 'dev-grace-inside',
      },
    });
    const inside = await getEntitlement(graceUserId, prisma);
    expect(inside.entitled).toBe(true);

    // Past-due 10 days ago: beyond the grace window.
    await prisma.subscription.updateMany({
      where: { userId: graceUserId },
      data: { currentPeriodEnd: new Date(now.getTime() - 10 * 86400000) },
    });
    const outside = await getEntitlement(graceUserId, prisma);
    expect(outside.entitled).toBe(false);

    // Zero-day grace restores the old fail-closed behavior.
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/billing.grace_period_days',
      headers: auth(superAdmin.token),
      payload: { value: 0 },
    });
    await prisma.subscription.updateMany({
      where: { userId: graceUserId },
      data: { currentPeriodEnd: new Date(now.getTime() - 1 * 86400000) },
    });
    const failClosed = await getEntitlement(graceUserId, prisma);
    expect(failClosed.entitled).toBe(false);

    // Restore the default.
    await app.inject({
      method: 'PUT',
      url: '/v1/admin/settings/billing.grace_period_days',
      headers: auth(superAdmin.token),
      payload: { value: 3 },
    });
  });

  it('products endpoint exposes plan pricing fields', async () => {
    const products = await app.inject({
      method: 'GET',
      url: '/v1/subscriptions/products',
      headers: auth(listener.token),
    });
    expect(products.statusCode).toBe(200);
    const list = products.json().products as Array<Record<string, unknown>>;
    const match = list.find((p) => p.planCode === 'test_plan_create');
    expect(match).toBeDefined();
    expect(match!.priceCents).toBe(999);
    expect(match!.currency).toBe('USD');
    expect(match!.billingInterval).toBe('MONTH');
    expect(match!.trialDays).toBe(7);
    expect(match!.features).toEqual(['Ad-free listening', 'Offline downloads']);
  });
});
