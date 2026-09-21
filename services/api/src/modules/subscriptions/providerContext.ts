// Phase 19 — store adapter resolution.
//
// Builds the real Apple/Google adapters from configuration. When a store
// integration is not configured, resolution throws 503 (the client can
// retry after the operator configures the store) rather than pretending
// verification succeeded. There is no fallback to unverified acceptance.

import type { PrismaClient } from '@prisma/client';
import type { SubscriptionsConfig } from '../../config.js';
import { serviceUnavailable } from '../../http/errors.js';
import type { SubscriptionProviderAdapter } from './providers.js';
import { AppleStoreAdapter } from './apple/provider.js';
import { GooglePlayAdapter } from './google/provider.js';
import type { FetchImpl } from './fetchOverride.js';

export type StoreProviderId = 'apple' | 'google';

export interface StoreAdapterDeps {
  config: SubscriptionsConfig;
  db: PrismaClient;
  fetchImpl?: FetchImpl;
}

/**
 * Resolve a store adapter. Throws 503 when the store integration is not
 * configured — verification is impossible without credentials, and failing
 * closed is the only safe behavior.
 */
export function getStoreAdapter(
  provider: StoreProviderId,
  deps: StoreAdapterDeps,
): SubscriptionProviderAdapter {
  if (provider === 'apple') {
    if (!deps.config.apple.enabled) {
      throw serviceUnavailable(
        'Apple App Store verification is not configured on this server. ' +
          'See docs/STORE-SETUP.md.',
      );
    }
    return new AppleStoreAdapter(deps.config.apple, deps.db, deps.fetchImpl);
  }
  if (!deps.config.google.enabled) {
    throw serviceUnavailable(
      'Google Play verification is not configured on this server. ' + 'See docs/STORE-SETUP.md.',
    );
  }
  return new GooglePlayAdapter(deps.config.google, deps.db, deps.fetchImpl);
}
