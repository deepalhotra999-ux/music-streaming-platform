// Phase 18 — subscription & entitlement endpoints.
// Thin wrappers over ApiClient; no business logic lives here. Entitlement
// is always computed server-side; these calls only display what the server
// reports.

import type { ApiClient } from './client';
import type { Entitlement, MySubscription } from './types';

/** The caller's current subscription plus server-computed entitlement. */
export async function getMySubscription(api: ApiClient): Promise<MySubscription> {
  return api.get<MySubscription>('/v1/subscriptions/me');
}

/** Lightweight server-computed premium-access check. */
export async function getMyEntitlement(api: ApiClient): Promise<Entitlement> {
  return api.get<Entitlement>('/v1/subscriptions/me/entitlement');
}
