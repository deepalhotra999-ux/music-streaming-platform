// Billing management — advanced subscription system. Admin-owned plan
// catalog, promo codes, and purchase controls.
//
// Plans are the purchasable catalog: price, currency, billing cadence,
// trial length, and feature list are all editable from the admin console.
// Deactivating a plan blocks NEW purchases (product mapping already
// requires active plans); existing subscribers keep their plan —
// deactivation is refused while paying subscribers exist, fail-closed.
//
// Promo codes are percent- or fixed-amount discounts with redemption
// limits, plan scoping, and validity windows. Redemptions are append-only;
// one redemption per user per code.
//
// Every mutation writes an admin audit event with before/after state.

import type { BillingInterval, PrismaClient, PromoCode } from '@prisma/client';
type PromoCodeRow = PromoCode;
import { badRequest, conflict, notFound, unprocessableEntity } from '../../http/errors.js';
import { recordAuditEvent } from '../audit/service.js';

export interface Actor {
  id: string;
  impersonation?: { adminId: string; reason: string } | null;
}

type Db = PrismaClient;

const PLAN_ID_RE = /^[a-z0-9][a-z0-9_]{1,63}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const PROMO_CODE_RE = /^[A-Z0-9-]{3,32}$/;
const BILLING_INTERVALS: BillingInterval[] = ['WEEK', 'MONTH', 'YEAR'];

/** Statuses that count as "paying" for plan-deactivation guards. */
const PAYING_STATUSES = ['ACTIVE', 'TRIALING', 'PAST_DUE'] as const;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface PlanInput {
  name: string;
  planType: 'INDIVIDUAL' | 'FAMILY' | 'STUDENT';
  priceCents: number;
  currency: string;
  billingInterval: BillingInterval;
  intervalCount?: number;
  trialDays?: number;
  features?: string[];
  sortOrder?: number;
  appleProductId?: string | null;
  googleProductId?: string | null;
  devProductId?: string | null;
}

function validatePlanInput(input: PlanInput): void {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw badRequest('Plan name is required.');
  }
  if (input.name.length > 120) throw badRequest('Plan name is too long (max 120).');
  if (!['INDIVIDUAL', 'FAMILY', 'STUDENT'].includes(input.planType)) {
    throw badRequest('planType must be INDIVIDUAL, FAMILY, or STUDENT.');
  }
  if (!Number.isInteger(input.priceCents) || input.priceCents < 0) {
    throw badRequest('priceCents must be a non-negative integer.');
  }
  if (typeof input.currency !== 'string' || !CURRENCY_RE.test(input.currency)) {
    throw badRequest('currency must be a 3-letter ISO code (e.g. USD).');
  }
  if (!BILLING_INTERVALS.includes(input.billingInterval)) {
    throw badRequest('billingInterval must be WEEK, MONTH, or YEAR.');
  }
  const intervalCount = input.intervalCount ?? 1;
  if (!Number.isInteger(intervalCount) || intervalCount < 1 || intervalCount > 52) {
    throw badRequest('intervalCount must be an integer between 1 and 52.');
  }
  const trialDays = input.trialDays ?? 0;
  if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) {
    throw badRequest('trialDays must be an integer between 0 and 365.');
  }
  if (input.features !== undefined) {
    if (
      !Array.isArray(input.features) ||
      input.features.some((f) => typeof f !== 'string' || f.length > 200)
    ) {
      throw badRequest('features must be an array of strings (max 200 chars each).');
    }
  }
  if (
    input.sortOrder !== undefined &&
    (!Number.isInteger(input.sortOrder) || input.sortOrder < 0)
  ) {
    throw badRequest('sortOrder must be a non-negative integer.');
  }
  for (const field of ['appleProductId', 'googleProductId', 'devProductId'] as const) {
    const v = input[field];
    if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 255)) {
      throw badRequest(`${field} must be a string (max 255) or null.`);
    }
  }
}

function planInputToData(input: PlanInput) {
  return {
    name: input.name.trim(),
    planType: input.planType,
    priceCents: input.priceCents,
    currency: input.currency,
    billingInterval: input.billingInterval,
    intervalCount: input.intervalCount ?? 1,
    trialDays: input.trialDays ?? 0,
    features: input.features ?? [],
    sortOrder: input.sortOrder ?? 0,
    appleProductId: input.appleProductId ?? null,
    googleProductId: input.googleProductId ?? null,
    devProductId: input.devProductId ?? null,
  };
}

export async function listPlans(db: Db) {
  const plans = await db.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  const counts = await db.subscription.groupBy({
    by: ['planId', 'status'],
    where: { status: { in: [...PAYING_STATUSES] } },
    _count: { _all: true },
  });
  const payingByPlan = new Map<string, number>();
  for (const c of counts) {
    payingByPlan.set(c.planId, (payingByPlan.get(c.planId) ?? 0) + c._count._all);
  }
  return plans.map((p) => ({ ...p, payingSubscribers: payingByPlan.get(p.id) ?? 0 }));
}

export async function createPlan(db: Db, actor: Actor, planId: string, input: PlanInput) {
  if (typeof planId !== 'string' || !PLAN_ID_RE.test(planId)) {
    throw badRequest('Plan id must be 2-64 chars: lowercase letters, digits, underscores.');
  }
  validatePlanInput(input);
  const existing = await db.plan.findUnique({ where: { id: planId } });
  if (existing) throw conflict(`Plan "${planId}" already exists.`);
  const plan = await db.plan.create({ data: { id: planId, ...planInputToData(input) } });
  await recordAuditEvent(
    {
      actor,
      action: 'billing.plan.created',
      targetType: 'plan',
      // Plan ids are slugs, not UUIDs; the audit target_id column is UUID.
      targetId: null,
      afterState: plan as unknown as Record<string, unknown>,
      metadata: { planId, planName: plan.name },
    },
    db,
  );
  return { ...plan, payingSubscribers: 0 };
}

export async function updatePlan(db: Db, actor: Actor, planId: string, input: Partial<PlanInput>) {
  const before = await db.plan.findUnique({ where: { id: planId } });
  if (!before) throw notFound(`Plan "${planId}" not found.`);
  // Validate the merged shape so partial updates still respect every rule.
  validatePlanInput({
    name: input.name ?? before.name,
    planType: (input.planType ?? before.planType) as PlanInput['planType'],
    priceCents: input.priceCents ?? before.priceCents,
    currency: input.currency ?? before.currency,
    billingInterval: (input.billingInterval ?? before.billingInterval) as BillingInterval,
    intervalCount: input.intervalCount ?? before.intervalCount,
    trialDays: input.trialDays ?? before.trialDays,
    features: (input.features ?? (before.features as string[])) as string[],
    sortOrder: input.sortOrder ?? before.sortOrder,
    appleProductId: input.appleProductId ?? before.appleProductId,
    googleProductId: input.googleProductId ?? before.googleProductId,
    devProductId: input.devProductId ?? before.devProductId,
  });
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.planType !== undefined) data.planType = input.planType;
  if (input.priceCents !== undefined) data.priceCents = input.priceCents;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.billingInterval !== undefined) data.billingInterval = input.billingInterval;
  if (input.intervalCount !== undefined) data.intervalCount = input.intervalCount;
  if (input.trialDays !== undefined) data.trialDays = input.trialDays;
  if (input.features !== undefined) data.features = input.features;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
  if (input.appleProductId !== undefined) data.appleProductId = input.appleProductId;
  if (input.googleProductId !== undefined) data.googleProductId = input.googleProductId;
  if (input.devProductId !== undefined) data.devProductId = input.devProductId;
  const after = await db.plan.update({ where: { id: planId }, data });
  const payingSubscribers = await db.subscription.count({
    where: { planId, status: { in: [...PAYING_STATUSES] } },
  });
  await recordAuditEvent(
    {
      actor,
      action: 'billing.plan.updated',
      targetType: 'plan',
      // Plan ids are slugs, not UUIDs; the audit target_id column is UUID.
      targetId: null,
      beforeState: before as unknown as Record<string, unknown>,
      afterState: after as unknown as Record<string, unknown>,
      metadata: { planId, changedFields: Object.keys(data) },
    },
    db,
  );
  return { ...after, payingSubscribers };
}

export async function setPlanActive(db: Db, actor: Actor, planId: string, active: boolean) {
  const before = await db.plan.findUnique({ where: { id: planId } });
  if (!before) throw notFound(`Plan "${planId}" not found.`);
  if (!active && before.active) {
    const paying = await db.subscription.count({
      where: { planId, status: { in: [...PAYING_STATUSES] } },
    });
    if (paying > 0) {
      throw conflict(
        `Cannot deactivate plan "${planId}": ${paying} paying subscriber(s) still on it. ` +
          'Move them to another plan first.',
      );
    }
  }
  const after = await db.plan.update({ where: { id: planId }, data: { active } });
  const payingSubscribers = await db.subscription.count({
    where: { planId, status: { in: [...PAYING_STATUSES] } },
  });
  await recordAuditEvent(
    {
      actor,
      action: active ? 'billing.plan.activated' : 'billing.plan.deactivated',
      targetType: 'plan',
      // Plan ids are slugs, not UUIDs; the audit target_id column is UUID.
      targetId: null,
      beforeState: { active: before.active },
      afterState: { active },
      metadata: { planId },
    },
    db,
  );
  return { ...after, payingSubscribers };
}

// ---------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------

export interface PromoInput {
  code: string;
  description?: string;
  percentOff?: number;
  amountOffCents?: number;
  currency?: string;
  maxRedemptions?: number | null;
  startsAt?: string | null;
  expiresAt?: string | null;
  applicablePlans?: string[];
}

function parseOptionalDate(raw: string | null | undefined, field: string): Date | null {
  if (raw === undefined || raw === null) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} must be an ISO-8601 date string.`);
  return d;
}

function validatePromoInput(input: PromoInput): void {
  if (typeof input.code !== 'string' || !PROMO_CODE_RE.test(input.code.toUpperCase())) {
    throw badRequest('code must be 3-32 chars: A-Z, 0-9, hyphens.');
  }
  const hasPercent = input.percentOff !== undefined;
  const hasAmount = input.amountOffCents !== undefined;
  if (hasPercent === hasAmount) {
    throw badRequest('Set exactly one of percentOff or amountOffCents.');
  }
  if (
    hasPercent &&
    (!Number.isInteger(input.percentOff) || input.percentOff! < 1 || input.percentOff! > 100)
  ) {
    throw badRequest('percentOff must be an integer between 1 and 100.');
  }
  if (hasAmount && (!Number.isInteger(input.amountOffCents) || input.amountOffCents! <= 0)) {
    throw badRequest('amountOffCents must be a positive integer.');
  }
  if (input.currency !== undefined && !CURRENCY_RE.test(input.currency)) {
    throw badRequest('currency must be a 3-letter ISO code (e.g. USD).');
  }
  if (
    input.maxRedemptions !== undefined &&
    input.maxRedemptions !== null &&
    (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions <= 0)
  ) {
    throw badRequest('maxRedemptions must be a positive integer or null.');
  }
  const startsAt = parseOptionalDate(input.startsAt, 'startsAt');
  const expiresAt = parseOptionalDate(input.expiresAt, 'expiresAt');
  if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
    throw badRequest('expiresAt must be after startsAt.');
  }
  if (input.description !== undefined && input.description.length > 500) {
    throw badRequest('description is too long (max 500).');
  }
  if (input.applicablePlans !== undefined) {
    if (
      !Array.isArray(input.applicablePlans) ||
      input.applicablePlans.some((p) => typeof p !== 'string')
    ) {
      throw badRequest('applicablePlans must be an array of plan ids.');
    }
  }
}

export async function listPromoCodes(db: Db) {
  return db.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
}

export async function createPromoCode(db: Db, actor: Actor, input: PromoInput) {
  validatePromoInput(input);
  const code = input.code.toUpperCase();
  const existing = await db.promoCode.findUnique({ where: { code } });
  if (existing) throw conflict(`Promo code "${code}" already exists.`);
  if (input.applicablePlans?.length) {
    const plans = await db.plan.findMany({
      where: { id: { in: input.applicablePlans } },
      select: { id: true },
    });
    if (plans.length !== input.applicablePlans.length) {
      throw badRequest('applicablePlans contains an unknown plan id.');
    }
  }
  const promo = await db.promoCode.create({
    data: {
      code,
      description: input.description ?? '',
      percentOff: input.percentOff ?? null,
      amountOffCents: input.amountOffCents ?? null,
      currency: input.currency ?? 'USD',
      maxRedemptions: input.maxRedemptions ?? null,
      startsAt: parseOptionalDate(input.startsAt, 'startsAt'),
      expiresAt: parseOptionalDate(input.expiresAt, 'expiresAt'),
      applicablePlans: input.applicablePlans ?? [],
      createdBy: actor.id,
    },
  });
  await recordAuditEvent(
    {
      actor,
      action: 'billing.promo.created',
      targetType: 'promo_code',
      targetId: promo.id,
      afterState: promo as unknown as Record<string, unknown>,
      metadata: { code },
    },
    db,
  );
  return promo;
}

export async function setPromoActive(db: Db, actor: Actor, id: string, active: boolean) {
  const before = await db.promoCode.findUnique({ where: { id } });
  if (!before) throw notFound('Promo code not found.');
  const after = await db.promoCode.update({ where: { id }, data: { active } });
  await recordAuditEvent(
    {
      actor,
      action: active ? 'billing.promo.activated' : 'billing.promo.deactivated',
      targetType: 'promo_code',
      targetId: id,
      beforeState: { active: before.active },
      afterState: { active },
      metadata: { code: before.code },
    },
    db,
  );
  return after;
}

export async function deletePromoCode(db: Db, actor: Actor, id: string) {
  const before = await db.promoCode.findUnique({ where: { id } });
  if (!before) throw notFound('Promo code not found.');
  if (before.redeemedCount > 0) {
    throw conflict(
      `Cannot delete promo code "${before.code}": it has ${before.redeemedCount} redemption(s). Deactivate it instead.`,
    );
  }
  await db.promoCode.delete({ where: { id } });
  await recordAuditEvent(
    {
      actor,
      action: 'billing.promo.deleted',
      targetType: 'promo_code',
      targetId: id,
      beforeState: before as unknown as Record<string, unknown>,
      metadata: { code: before.code },
    },
    db,
  );
}

export interface PromoValidation {
  valid: boolean;
  reason?: string;
  promo?: PromoCodeRow;
}

/**
 * Validate a promo code for a user + plan without consuming it. Used by the
 * admin console preview and (later) the mobile checkout sheet.
 */
export async function validatePromoCode(
  db: Db,
  rawCode: string,
  userId: string,
  planId?: string,
  now: Date = new Date(),
): Promise<PromoValidation> {
  const code = rawCode.toUpperCase();
  const promo = await db.promoCode.findUnique({ where: { code } });
  if (!promo) return { valid: false, reason: 'unknown_code' };
  if (!promo.active) return { valid: false, reason: 'inactive' };
  if (promo.startsAt && now < promo.startsAt) return { valid: false, reason: 'not_started' };
  if (promo.expiresAt && now >= promo.expiresAt) return { valid: false, reason: 'expired' };
  if (promo.maxRedemptions !== null && promo.redeemedCount >= promo.maxRedemptions) {
    return { valid: false, reason: 'fully_redeemed' };
  }
  if (planId) {
    const applicable = promo.applicablePlans as string[];
    if (applicable.length > 0 && !applicable.includes(planId)) {
      return { valid: false, reason: 'plan_not_eligible' };
    }
  }
  const already = await db.promoRedemption.findUnique({
    where: { promoCodeId_userId: { promoCodeId: promo.id, userId } },
  });
  if (already) return { valid: false, reason: 'already_redeemed' };
  return { valid: true, promo };
}

/**
 * Redeem a promo code for a user. Atomic: re-validates inside the
 * transaction and increments the redemption counter, so concurrent
 * redemptions cannot overshoot maxRedemptions.
 */
export async function redeemPromoCode(
  db: Db,
  rawCode: string,
  userId: string,
  subscriptionId?: string,
  planId?: string,
): Promise<{ promoCodeId: string; code: string }> {
  const code = rawCode.toUpperCase();
  return db.$transaction(async (tx) => {
    const promo = await tx.promoCode.findUnique({ where: { code } });
    if (!promo) throw notFound(`Promo code "${code}" not found.`);
    const validation = await validatePromoCode(tx as unknown as Db, code, userId, planId);
    if (!validation.valid) {
      throw unprocessableEntity(`Promo code "${code}" cannot be redeemed: ${validation.reason}.`);
    }
    // Re-check the cap inside the transaction against the fresh row.
    const fresh = await tx.promoCode.findUnique({ where: { id: promo.id } });
    if (fresh!.maxRedemptions !== null && fresh!.redeemedCount >= fresh!.maxRedemptions) {
      throw unprocessableEntity(`Promo code "${code}" is fully redeemed.`);
    }
    await tx.promoRedemption.create({
      data: {
        promoCodeId: promo.id,
        userId,
        subscriptionId: subscriptionId ?? null,
      },
    });
    await tx.promoCode.update({
      where: { id: promo.id },
      data: { redeemedCount: { increment: 1 } },
    });
    await recordAuditEvent(
      {
        actor: { id: userId },
        action: 'billing.promo.redeemed',
        targetType: 'promo_code',
        targetId: promo.id,
        metadata: { code, subscriptionId: subscriptionId ?? null },
      },
      tx as unknown as Db,
    );
    return { promoCodeId: promo.id, code };
  });
}
