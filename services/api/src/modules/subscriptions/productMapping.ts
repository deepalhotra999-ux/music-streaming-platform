// Phase 19 — store product mapping.
//
// Store product identifiers (Apple product IDs, Google Play SKUs) map to
// internal plans through the `plans` table — never through hard-coded
// literals in business logic. The Apple/Google product columns are NULL
// until deployment configures them (direct DB update or a future admin
// surface); DEV product IDs are seeded for local testing.
//
// A store product ID is only usable when it maps to exactly one active
// plan. Unknown or inactive mappings are rejected (422) so a misconfigured
// store catalog can never grant the wrong plan.

import type { PrismaClient, SubscriptionProvider } from '@prisma/client';
import { unprocessableEntity } from '../../http/errors.js';

export interface StorePlanMapping {
  /** Internal plan code, e.g. "premium_individual". */
  planCode: string;
  planName: string;
  planType: string;
  /** The store product identifier that was resolved. */
  storeProductId: string;
}

/**
 * Resolve a store product identifier to its internal plan. The mapping
 * lives in the database (`plans.apple_product_id` /
 * `plans.google_product_id`); this function performs no caching so product
 * reconfiguration takes effect immediately.
 */
export async function resolvePlanByStoreProduct(
  provider: 'APPLE' | 'GOOGLE',
  storeProductId: string,
  db: PrismaClient,
): Promise<StorePlanMapping> {
  const column = provider === 'APPLE' ? 'appleProductId' : 'googleProductId';
  const plans = await db.plan.findMany({
    where: { [column]: storeProductId, active: true },
    select: { id: true, name: true, planType: true },
  });
  if (plans.length === 0) {
    throw unprocessableEntity(
      `Unknown ${provider === 'APPLE' ? 'App Store' : 'Google Play'} product: ` +
        `"${storeProductId}". Configure it on a plan before accepting purchases.`,
    );
  }
  if (plans.length > 1) {
    // A defensive uniqueness check: the same store product must never map
    // to two plans, or entitlement could be granted for the wrong plan.
    throw unprocessableEntity(
      `Store product "${storeProductId}" maps to multiple plans; refusing to guess.`,
    );
  }
  const plan = plans[0];
  return {
    planCode: plan.id,
    planName: plan.name,
    planType: plan.planType,
    storeProductId,
  };
}

/** Prisma provider enum value for a store product lookup. */
export function toMappingProvider(provider: 'apple' | 'google'): SubscriptionProvider {
  return (provider === 'apple' ? 'APPLE' : 'GOOGLE') as SubscriptionProvider;
}
