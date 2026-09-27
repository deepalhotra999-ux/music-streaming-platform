// Phase 18 — subscriptions. Server-side entitlement service.
//
// This module is the ONLY place that decides whether a user currently has
// access to premium playback. Rules:
//
// - Entitlement is derived from authoritative subscription state in the
//   database. Client-provided "premium"/"subscribed"/entitlement flags are
//   never read, anywhere.
// - `getEntitlement(userId, db, now)` is the single entry point. Playback
//   sessions, user endpoints, and admin inspection all call it; the rules
//   are not duplicated across controllers/routes.
// - The "current" subscription is the user's latest subscription row by
//   creation time. History rows remain for audit; only the latest row
//   grants access.
// - Semantics (see ADR-014):
//     ACTIVE                       → entitled only while
//                                    currentPeriodStart <= now < currentPeriodEnd.
//                                    Missing or invalid period fails closed.
//     TRIALING                     → entitled only while now < currentPeriodEnd.
//                                    Missing trial end fails closed.
//     PAST_DUE                     → denied (fail-closed; no grace window).
//     CANCELED                     → denied immediately (per the Phase 18
//                                    brief: CANCELED denies new sessions).
//     EXPIRED / REVOKED / no row   → never entitled
// - The period boundary is fail-closed: now >= currentPeriodEnd means the
//   access window has ended.
// - Existing playback sessions are untouched by this module: they are
//   short-lived opaque tokens (15 min) that expire on their own. Revoking
//   access stops NEW sessions immediately; in-flight sessions die with
//   their token.

import type { PrismaClient, SubscriptionStatus } from '@prisma/client';
import { getSettingValue } from '../ops/settings.js';

export type EntitlementDenyReason =
  | 'no_subscription'
  | 'subscription_expired'
  | 'subscription_revoked'
  | 'subscription_canceled'
  | 'subscription_past_due'
  | 'access_period_ended';

export interface EntitlementResult {
  entitled: boolean;
  /** Subscription status driving the decision, or 'NONE' when no row exists. */
  status: SubscriptionStatus | 'NONE';
  /** Plan code (e.g. "premium_individual"), null when no subscription. */
  planCode: string | null;
  /** ISO-8601, null when the subscription has no period end. */
  currentPeriodEnd: string | null;
  /** Machine-readable denial reason; 'ok' when entitled. */
  reason: EntitlementDenyReason | 'ok';
}

export interface SubscriptionRow {
  status: SubscriptionStatus;
  planId: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

export interface EntitlementOptions {
  /**
   * Billing management — days a PAST_DUE subscription keeps premium access
   * after the paid period ends. 0 (default) preserves the fail-closed
   * behavior: no grace window.
   */
  gracePeriodDays?: number;
}

/**
 * Pure entitlement decision over a subscription row. Pure so the rules are
 * trivially unit-testable; `getEntitlement` adds the DB lookup.
 */
export function resolveEntitlement(
  sub: SubscriptionRow | null,
  now: Date = new Date(),
  opts: EntitlementOptions = {},
): EntitlementResult {
  if (!sub) {
    return {
      entitled: false,
      status: 'NONE',
      planCode: null,
      currentPeriodEnd: null,
      reason: 'no_subscription',
    };
  }
  const currentPeriodEnd = sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null;
  const base = { status: sub.status, planCode: sub.planId, currentPeriodEnd };

  switch (sub.status) {
    case 'ACTIVE': {
      // Entitled only inside the paid period. Missing start/end, a future
      // start, or an ended period all fail closed — without a provider-set
      // window there is nothing to grant.
      const start = sub.currentPeriodStart;
      const end = sub.currentPeriodEnd;
      if (start && end && start.getTime() <= now.getTime() && now.getTime() < end.getTime()) {
        return { ...base, entitled: true, reason: 'ok' };
      }
      return { ...base, entitled: false, reason: 'access_period_ended' };
    }
    case 'TRIALING': {
      // Trials carry their own end date; fail closed when it is missing or
      // has passed.
      if (sub.currentPeriodEnd && now.getTime() < sub.currentPeriodEnd.getTime()) {
        return { ...base, entitled: true, reason: 'ok' };
      }
      return { ...base, entitled: false, reason: 'access_period_ended' };
    }
    case 'PAST_DUE': {
      // Billing management — configurable grace window: a past-due
      // subscription keeps access for gracePeriodDays after the paid period
      // ends, giving the store's retry logic time to recover. Missing period
      // end or 0 grace days fail closed, exactly as before.
      const graceDays = opts.gracePeriodDays ?? 0;
      const end = sub.currentPeriodEnd;
      if (
        graceDays > 0 &&
        end &&
        now.getTime() < end.getTime() + graceDays * 86_400_000
      ) {
        return { ...base, entitled: true, reason: 'ok' };
      }
      return { ...base, entitled: false, reason: 'subscription_past_due' };
    }
    case 'CANCELED':
      // Denied immediately per the Phase 18 brief — cancellation ends new
      // sessions even inside the paid period.
      return { ...base, entitled: false, reason: 'subscription_canceled' };
    case 'EXPIRED':
      return { ...base, entitled: false, reason: 'subscription_expired' };
    case 'REVOKED':
      return { ...base, entitled: false, reason: 'subscription_revoked' };
  }
}

/**
 * Load the user's latest subscription and decide entitlement. The single
 * entry point every caller uses. The grace window comes from the
 * `billing.grace_period_days` platform setting (default 3).
 */
export async function getEntitlement(
  userId: string,
  db: PrismaClient,
  now: Date = new Date(),
): Promise<EntitlementResult> {
  const sub = await db.subscription.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { status: true, planId: true, currentPeriodStart: true, currentPeriodEnd: true },
  });
  const gracePeriodDays = await getSettingValue<number>('billing.grace_period_days', db);
  return resolveEntitlement(sub, now, { gracePeriodDays });
}
