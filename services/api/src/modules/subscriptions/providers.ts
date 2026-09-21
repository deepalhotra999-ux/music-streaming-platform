// Phase 19 — subscriptions. Provider-neutral subscription interface.
//
// The platform supports Apple App Store and Google Play billing through
// real server-side verification:
//
// - `SubscriptionProviderAdapter` is the contract a store integration
//   implements: verify a purchase token with the store, and normalize a
//   store server notification into a provider-neutral domain event.
// - `apple/` implements the App Store adapter: App Store Server API
//   transaction verification plus App Store Server Notifications v2
//   (signed JWS payloads, verified server-side against Apple's cert chain).
// - `google/` implements the Google Play adapter: Play Developer API
//   subscription verification plus Real-time Developer Notifications
//   (Pub/Sub push, verified by shared token, state re-fetched server-side).
// - `devProvider` is the deterministic development/test adapter. It accepts
//   caller-supplied event payloads WITHOUT any store verification, which is
//   why it is only reachable when DEV_SUBSCRIPTIONS_ENABLED is true (and
//   never in production — enforced at config load).
//
// Security rule, stated once: the server NEVER accepts an arbitrary client
// claim ("I paid", a transaction id, a receipt blob) as proof of purchase.
// Only a provider adapter's verified/normalized event mutates subscription
// state. Client-submitted transaction data is always verified against the
// store before it can affect entitlement.

import type { SubscriptionEventType, SubscriptionProvider } from '@prisma/client';
import { unprocessableEntity } from '../../http/errors.js';

/** Provider ids the platform knows about. Lowercase at the HTTP boundary. */
export type ProviderId = 'apple' | 'google' | 'dev';

export const PROVIDER_IDS: readonly ProviderId[] = ['apple', 'google', 'dev'];

export function toPrismaProvider(id: ProviderId): SubscriptionProvider {
  return id.toUpperCase() as SubscriptionProvider;
}

/**
 * A provider-neutral subscription event, normalized from a store server
 * notification (or synthesized deterministically by the DEV adapter).
 */
export interface NormalizedProviderEvent {
  /** Idempotency key: unique per provider. Duplicates must not fork history. */
  providerEventId: string;
  eventType: SubscriptionEventType;
  /** The store's subscription identifier (stable across renewals). */
  externalSubscriptionId: string;
  /**
   * Phase 19 — token migration. When the store issues a NEW external
   * identifier that supersedes a previously known one (e.g. Google Play
   * issues a new purchase token on plan change and reports the old one as
   * `linkedPurchaseToken`), the service migrates the subscription row to
   * the new identifier instead of forking a second subscription.
   */
  supersedesExternalSubscriptionId?: string;
  /** Plan code (e.g. "premium_individual") for create/plan-change events. */
  planCode?: string;
  /** Access window the event grants. */
  periodStart?: Date;
  periodEnd?: Date;
  /**
   * Phase 19 — whether the event arrived through real store verification
   * (signature/API checks). Apple/Google adapters set this; the DEV
   * adapter never does.
   */
  verified?: boolean;
  /**
   * Phase 19 — the store's record of which app user made the purchase
   * (Apple's appAccountToken, set by the mobile app at purchase time).
   * Used to attribute first-seen subscriptions from server notifications
   * and to bind client verifications to the calling user.
   */
  appAccountUserId?: string;
  /** Optional structured, sanitized facts (cancel reason, etc.). */
  facts?: Record<string, string>;
}

/**
 * The contract a store billing integration implements.
 *
 * `verifyPurchase` verifies a client-supplied purchase token against the
 * store and returns the normalized event. It must throw for unverifiable
 * input — never return "verified" on trust.
 *
 * `normalizeServerEvent` normalizes a store server notification into a
 * domain event. The HTTP layer authenticates the notification
 * (signature/token checks) before calling this; adapters that need the
 * authoritative store state (Google RTDN) may call back to the store API
 * here, which is why normalization is async.
 */
export interface SubscriptionProviderAdapter {
  readonly id: ProviderId;
  verifyPurchase(purchaseToken: string): Promise<NormalizedProviderEvent>;
  /**
   * Normalize an already-authenticated store server notification. Returns
   * null for notifications that carry no lifecycle change (Apple test
   * pings, consumption requests, …) — the HTTP layer acknowledges those
   * without touching subscription state.
   */
  normalizeServerEvent(raw: unknown): Promise<NormalizedProviderEvent | null>;
}

export interface DevEventInput {
  providerEventId: string;
  eventType: SubscriptionEventType;
  externalSubscriptionId: string;
  planCode?: string;
  periodStart?: string;
  periodEnd?: string;
  facts?: Record<string, string>;
}

/**
 * Deterministic development/test adapter. Normalizes a caller-supplied
 * event body into a domain event with NO store verification — that is the
 * entire point (deterministic lifecycle testing without real payments),
 * and also why this adapter is unreachable unless the dev flag is on.
 *
 * Validation here is structural (required fields, sane dates); business
 * rules (valid state transitions, known plans) are enforced by the
 * subscription service, not the adapter.
 */
export const devProvider = {
  id: 'dev' as const,
  normalizeDevEvent(input: DevEventInput): NormalizedProviderEvent {
    if (!input.providerEventId || typeof input.providerEventId !== 'string') {
      throw unprocessableEntity('providerEventId is required.');
    }
    if (!input.externalSubscriptionId || typeof input.externalSubscriptionId !== 'string') {
      throw unprocessableEntity('externalSubscriptionId is required.');
    }
    const periodStart = parseOptionalDate(input.periodStart, 'periodStart');
    const periodEnd = parseOptionalDate(input.periodEnd, 'periodEnd');
    if (periodStart && periodEnd && periodEnd.getTime() <= periodStart.getTime()) {
      throw unprocessableEntity('periodEnd must be after periodStart.');
    }
    return {
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      externalSubscriptionId: input.externalSubscriptionId,
      planCode: input.planCode,
      periodStart,
      periodEnd,
      facts: input.facts,
    };
  },
};

function parseOptionalDate(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw unprocessableEntity(`${field} must be an ISO-8601 date string.`);
  }
  return date;
}

/**
 * Phase 19 — adapter resolution moved to providerContext.ts, which builds
 * real Apple/Google adapters from configuration (or throws 503 when the
 * store integration is not configured). The DEV provider keeps its
 * dedicated dev-event endpoint and has no store verification path.
 */
export function getProviderAdapter(id: ProviderId): SubscriptionProviderAdapter {
  switch (id) {
    case 'apple':
    case 'google':
      throw unprocessableEntity(
        'Use getStoreAdapter from providerContext.js to resolve the Apple/Google ' +
          'adapters; they require configuration and database access.',
      );
    case 'dev':
      throw unprocessableEntity(
        'The DEV provider has no store verification path by design; ' +
          'use the dev event endpoint instead.',
      );
  }
}
