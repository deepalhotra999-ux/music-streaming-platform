// Phase 7 — streaming. Entitlement check contract.
// Phase 18 — the placeholder body is replaced with the real server-side
// entitlement service. Routes are untouched: they still call
// `checkPlaybackEntitlement` and deny with 403 when it returns
// `allowed: false`.
//
// The decision is ALWAYS derived from authoritative subscription state via
// `getEntitlement`. No client-provided "premium"/"subscribed" flag is ever
// consulted — such flags cannot reach this module (the session route takes
// only a trackId).

import type { PrismaClient } from '@prisma/client';
import { getEntitlement } from '../subscriptions/entitlements.js';

export interface EntitlementDecision {
  allowed: boolean;
  /** Human-readable reason, surfaced in the 403 detail when denied. */
  reason: string;
}

export interface EntitlementContext {
  userId: string;
  trackId: string;
  db: PrismaClient;
}

/**
 * Decide whether a user may start a new playback session right now.
 *
 * Denied with the dedicated "Subscription Required" reason so clients can
 * render locked UI; the route maps this to the subscription-required 403.
 */
export async function checkPlaybackEntitlement(
  ctx: EntitlementContext,
): Promise<EntitlementDecision> {
  const entitlement = await getEntitlement(ctx.userId, ctx.db);
  if (entitlement.entitled) {
    return {
      allowed: true,
      reason: `subscription ${entitlement.status}`,
    };
  }
  return {
    allowed: false,
    reason: `subscription required (${entitlement.reason})`,
  };
}
