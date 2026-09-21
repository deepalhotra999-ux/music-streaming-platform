// Phase 18 — subscriptions. Provider-neutral subscription interface.
//
// The platform must support Apple App Store and Google Play billing, but real
// store purchase flows are NOT implemented in this phase. This module defines
// the integration boundary:
//
// - `SubscriptionProviderAdapter` is the contract a store integration must
//   implement: verify a purchase token with the store, and normalize a
//   store server notification into a provider-neutral domain event.
// - `appleProvider` / `googleProvider` are explicit stubs. They throw a
//   "not implemented" error that names the future integration boundary, so
//   no code path can mistake them for working verification.
// - `devProvider` is the deterministic development/test adapter. It accepts
//   caller-supplied event payloads WITHOUT any store verification, which is
//   why it is only reachable when DEV_SUBSCRIPTIONS_ENABLED is true (and
//   never in production — enforced at config load).
//
// Security rule, stated once: the server NEVER accepts an arbitrary client
// claim ("I paid", a transaction id, a receipt blob) as proof of purchase.
// Only a provider adapter's verified/normalized event mutates subscription
// state, and only APPLE/GOOGLE adapters will ever perform real verification.

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
  /** Plan code (e.g. "premium_individual") for create/plan-change events. */
  planCode?: string;
  /** Access window the event grants. */
  periodStart?: Date;
  periodEnd?: Date;
  /** Optional structured, sanitized facts (cancel reason, etc.). */
  facts?: Record<string, string>;
}

/**
 * The contract a store billing integration implements.
 *
 * `verifyPurchase` is the future integration boundary: for Apple this is
 * the App Store Server API (verify a signed transaction / respond to
 * App Store Server Notifications v2); for Google it is the Google Play
 * Developer API (purchases.subscriptionsv2.get + Real-time Developer
 * Notifications). See ADR-014.
 */
export interface SubscriptionProviderAdapter {
  readonly id: ProviderId;
  /**
   * Verify a client-supplied purchase token against the store and return
   * the normalized event. Must throw for unverifiable input — never
   * return "verified" on trust.
   */
  verifyPurchase(purchaseToken: string): Promise<NormalizedProviderEvent>;
  /**
   * Normalize an already-authenticated store server notification into a
   * domain event. "Already-authenticated" means the HTTP layer verified
   * the notification's signature / source before calling this.
   */
  normalizeServerEvent(raw: unknown): NormalizedProviderEvent;
}

function notImplementedBoundary(provider: string, boundary: string): Error {
  return unprocessableEntity(
    `${provider} billing is not integrated yet. Integration boundary: ${boundary}. ` +
      'See ADR-014. Deterministic testing uses the DEV provider.',
  );
}

/**
 * Apple App Store adapter — STUB. Real implementation verifies purchases via
 * the App Store Server API and consumes App Store Server Notifications v2.
 */
export const appleProvider: SubscriptionProviderAdapter = {
  id: 'apple',
  async verifyPurchase(): Promise<NormalizedProviderEvent> {
    throw notImplementedBoundary(
      'Apple App Store',
      'App Store Server API transaction verification + Server Notifications v2',
    );
  },
  normalizeServerEvent(): NormalizedProviderEvent {
    throw notImplementedBoundary(
      'Apple App Store',
      'App Store Server Notifications v2 (signed payload verification)',
    );
  },
};

/**
 * Google Play adapter — STUB. Real implementation verifies purchases via the
 * Google Play Developer API and consumes Real-time Developer Notifications.
 */
export const googleProvider: SubscriptionProviderAdapter = {
  id: 'google',
  async verifyPurchase(): Promise<NormalizedProviderEvent> {
    throw notImplementedBoundary(
      'Google Play',
      'Play Developer API purchases.subscriptionsv2 + Real-time Developer Notifications',
    );
  },
  normalizeServerEvent(): NormalizedProviderEvent {
    throw notImplementedBoundary(
      'Google Play',
      'Real-time Developer Notifications (Pub/Sub signature verification)',
    );
  },
};

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

export function getProviderAdapter(id: ProviderId): SubscriptionProviderAdapter {
  switch (id) {
    case 'apple':
      return appleProvider;
    case 'google':
      return googleProvider;
    case 'dev':
      throw unprocessableEntity(
        'The DEV provider has no store verification path by design; ' +
          'use the dev event endpoint instead.',
      );
  }
}
