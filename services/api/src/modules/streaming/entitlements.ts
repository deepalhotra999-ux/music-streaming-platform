// Phase 7 — streaming. Entitlement check placeholder.
//
// Subscriptions and entitlements arrive in Phase 8. This module already
// defines the contract the playback routes enforce — allow/deny with a
// reason — so Phase 8 only replaces the body of `checkPlaybackEntitlement`
// (with a subscription/entitlement lookup) without touching any route.

export interface EntitlementDecision {
  allowed: boolean;
  /** Human-readable reason, surfaced in the 403 detail when denied. */
  reason: string;
}

export interface EntitlementContext {
  userId: string;
  trackId: string;
}

/**
 * Decide whether a user may stream a track right now.
 *
 * Phase 7 (development): allow everything. The check is still invoked on
 * every playback-session creation so the enforcement point is real and
 * tested; denial paths are exercised in tests by stubbing this module.
 */
export async function checkPlaybackEntitlement(
  ctx: EntitlementContext,
): Promise<EntitlementDecision> {
  // Phase 8 will inspect ctx.userId / ctx.trackId against the subscription
  // and entitlement tables. Referenced here so the contract stays honest.
  void ctx;
  return {
    allowed: true,
    reason: 'development: entitlement checks are not enforced yet (see Phase 8)',
  };
}
