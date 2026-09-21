// Phase 18 — subscription & entitlement endpoints.
// Thin wrappers over ApiClient; no business logic lives here. Entitlement
// is always computed server-side; these calls only display what the server
// reports.
//
// Phase 19 — adds store product listing and purchase verification. The
// client NEVER grants entitlement: it sends the store purchase token to
// the backend, which verifies with Apple/Google before recording anything.

import type { ApiClient } from './client';
import type {
  Entitlement,
  MySubscription,
  StoreProductsResponse,
  VerifyPurchaseResponse,
} from './types';

/** The caller's current subscription plus server-computed entitlement. */
export async function getMySubscription(api: ApiClient): Promise<MySubscription> {
  return api.get<MySubscription>('/v1/subscriptions/me');
}

/** Lightweight server-computed premium-access check. */
export async function getMyEntitlement(api: ApiClient): Promise<Entitlement> {
  return api.get<Entitlement>('/v1/subscriptions/me/entitlement');
}

/**
 * Phase 19 — list purchasable store products. Product IDs come from the
 * server's plan table; the client never hard-codes store SKUs.
 */
export async function getStoreProducts(api: ApiClient): Promise<StoreProductsResponse> {
  return api.get<StoreProductsResponse>('/v1/subscriptions/products');
}

/**
 * Phase 19 — verify a store purchase with the backend. The backend
 * verifies the token against Apple/Google; only a verified purchase
 * creates or updates a subscription. A client-side "purchase succeeded"
 * callback alone grants nothing.
 *
 * @param provider 'apple' | 'google' — the store the purchase came from.
 * @param purchaseToken The store's purchase token (Apple: signed
 *   transaction JWS or transaction id; Google: purchase token).
 */
export async function verifyPurchase(
  api: ApiClient,
  provider: 'apple' | 'google',
  purchaseToken: string,
): Promise<VerifyPurchaseResponse> {
  return api.post<VerifyPurchaseResponse>('/v1/subscriptions/verify-purchase', {
    provider,
    purchaseToken,
  });
}
