// Phase 19 — Google Play adapter.
//
// Two integration points, both server-side:
//
//  1. Play Developer API (`purchases.subscriptionsv2.get`) — verifies a
//     client-supplied purchase token and returns the authoritative
//     subscription state. Client input is NEVER trusted on its own.
//  2. Real-time Developer Notifications — a Pub/Sub push to our endpoint.
//     The push is authenticated by the shared verification token in the
//     endpoint URL (checked by the HTTP layer). The notification payload
//     itself is minimal, so every notification triggers a re-fetch of the
//     authoritative state from the Play API; the fetched state — not the
//     notification's claims — drives the normalized event.
//
// Token lifecycle notes:
// - The purchase token is the subscription's external id. Google issues a
//   NEW purchase token on plan changes; the old token arrives as
//   `linkedPurchaseToken` and the service migrates the row instead of
//   forking a second subscription.
// - Unacknowledged purchases are acknowledged best-effort after
//   verification (Google refunds unacknowledged purchases). A failed
//   acknowledgement never fails verification; it is recorded in facts.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { badRequest, serviceUnavailable, unprocessableEntity } from '../../../http/errors.js';
import type { GooglePlayConfig } from '../../../config.js';
import { resolvePlanByStoreProduct } from '../productMapping.js';
import type { NormalizedProviderEvent, SubscriptionProviderAdapter } from '../providers.js';
import { resolveFetch, type FetchImpl } from '../fetchOverride.js';
import { GoogleAuth, parseServiceAccount } from './auth.js';

const ANDROID_PUBLISHER = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

/** RTDN notification types that carry no lifecycle change — acknowledge, ignore. */
const IGNORED_RTDN_TYPES = new Set([8, 11]);

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`Google payload: "${field}" must be a non-empty string.`);
  }
  return value;
}

interface GoogleSubscriptionState {
  productId: string;
  startTimeMillis: number;
  expiryTimeMillis: number;
  acknowledgementState: number;
  linkedPurchaseToken?: string;
  canceled: boolean;
  paused: boolean;
  autoRenewing: boolean;
}

function parseSubscriptionState(body: Record<string, unknown>): GoogleSubscriptionState {
  const lineItems = body.lineItems;
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw unprocessableEntity('Google Play returned a subscription with no line items.');
  }
  const item = asRecord(lineItems[0], 'line item');
  const expiryTimeMillis = Number(asString(item.expiryTime, 'lineItems[0].expiryTime'));
  if (!Number.isFinite(expiryTimeMillis)) {
    throw unprocessableEntity('Google Play returned an invalid expiryTime.');
  }
  const startTimeMillis = Number(typeof body.startTime === 'string' ? body.startTime : '0');
  const acknowledgementState =
    typeof body.acknowledgementState === 'number' ? body.acknowledgementState : 1;
  const canceledState = body.canceledState;
  const pausedState = (body.pausedStateContext ?? body.pausedState) as unknown;
  return {
    productId: asString(item.productId, 'lineItems[0].productId'),
    startTimeMillis: Number.isFinite(startTimeMillis) ? startTimeMillis : 0,
    expiryTimeMillis,
    acknowledgementState,
    linkedPurchaseToken:
      typeof body.linkedPurchaseToken === 'string' ? body.linkedPurchaseToken : undefined,
    canceled: typeof canceledState === 'string' && canceledState.length > 0,
    paused: pausedState !== undefined && pausedState !== null,
    autoRenewing: typeof item.autoRenewingPlan === 'object' && item.autoRenewingPlan !== null,
  };
}

export class GooglePlayAdapter implements SubscriptionProviderAdapter {
  readonly id = 'google' as const;
  private readonly auth: GoogleAuth;
  private readonly fetchImpl: FetchImpl;

  constructor(
    private readonly cfg: GooglePlayConfig,
    private readonly db: PrismaClient,
    fetchImpl?: FetchImpl,
  ) {
    if (!cfg.enabled || !cfg.serviceAccountJson) {
      throw serviceUnavailable('Google Play billing is not configured on this server.');
    }
    // Reuse the shared test fetch override so HTTP tests stay deterministic.
    this.fetchImpl = resolveFetch(fetchImpl);
    this.auth = new GoogleAuth(parseServiceAccount(cfg.serviceAccountJson), this.fetchImpl);
  }

  private async apiGet(path: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${ANDROID_PUBLISHER}${path}`, {
      headers: { Authorization: `Bearer ${await this.auth.accessToken()}` },
    });
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) {
        throw unprocessableEntity('Google Play could not find that purchase.');
      }
      throw serviceUnavailable(`Google Play Developer API error (HTTP ${res.status}).`);
    }
    return asRecord(await res.json(), 'Play Developer API response');
  }

  /**
   * Fetch the authoritative subscription state for a purchase token.
   * Acknowledges the purchase best-effort when Google reports it as
   * unacknowledged.
   */
  private async fetchState(purchaseToken: string): Promise<{
    state: GoogleSubscriptionState;
    facts: Record<string, string>;
  }> {
    const facts: Record<string, string> = {};
    const body = await this.apiGet(
      `/applications/${this.cfg.packageName}/purchases/subscriptionsv2/${encodeURIComponent(purchaseToken)}`,
    );
    const state = parseSubscriptionState(body);

    if (state.acknowledgementState === 0) {
      try {
        const res = await this.fetchImpl(
          `${ANDROID_PUBLISHER}/applications/${this.cfg.packageName}/purchases/subscriptions/acknowledge`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${await this.auth.accessToken()}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token: purchaseToken }),
          },
        );
        facts.acknowledged = res.ok ? 'true' : `failed:${res.status}`;
      } catch {
        facts.acknowledged = 'failed:network';
      }
    }
    return { state, facts };
  }

  private async buildEvent(
    purchaseToken: string,
    state: GoogleSubscriptionState,
    providerEventId: string,
    extraFacts: Record<string, string>,
    rtdnType?: number,
  ): Promise<NormalizedProviderEvent> {
    const mapping = await resolvePlanByStoreProduct('GOOGLE', state.productId, this.db);
    const now = Date.now();
    const facts: Record<string, string> = {
      storeProductId: state.productId,
      // The raw purchase token is a bearer credential — store only a hash.
      purchaseTokenHash: createHash('sha256').update(purchaseToken).digest('hex').slice(0, 16),
      ...extraFacts,
    };
    if (rtdnType !== undefined) facts.rtdnType = String(rtdnType);

    let eventType: NormalizedProviderEvent['eventType'];
    if (state.expiryTimeMillis <= now) {
      eventType = 'SUBSCRIPTION_EXPIRED';
    } else if (state.canceled || state.paused) {
      // Canceled (or paused) but still inside the paid period: the
      // subscription will not renew. Modeled as CANCELED per ADR-014.
      eventType = 'SUBSCRIPTION_CANCELED';
    } else if (rtdnType === 5) {
      eventType = 'PAYMENT_FAILED'; // ON_HOLD
    } else if (rtdnType === 6) {
      eventType = 'SUBSCRIPTION_GRACE_PERIOD'; // IN_GRACE_PERIOD
    } else {
      eventType = 'RENEWAL_SUCCEEDED';
    }

    return {
      providerEventId,
      eventType,
      externalSubscriptionId: purchaseToken,
      supersedesExternalSubscriptionId: state.linkedPurchaseToken,
      planCode: mapping.planCode,
      periodStart: new Date(state.startTimeMillis),
      periodEnd: new Date(state.expiryTimeMillis),
      verified: true,
      facts,
    };
  }

  /**
   * Verify a client-supplied Google Play purchase token against the Play
   * Developer API.
   */
  async verifyPurchase(purchaseToken: string): Promise<NormalizedProviderEvent> {
    if (
      typeof purchaseToken !== 'string' ||
      purchaseToken.length === 0 ||
      purchaseToken.length > 4096
    ) {
      throw badRequest('purchaseToken must be a non-empty string.');
    }
    const { state, facts } = await this.fetchState(purchaseToken);
    return this.buildEvent(purchaseToken, state, `google:client-verify:${purchaseToken}`, facts);
  }

  /**
   * Normalize a Real-time Developer Notification (Pub/Sub push envelope).
   * The envelope is authenticated by the HTTP layer (shared URL token);
   * the payload's package name is checked; then the authoritative state is
   * re-fetched from the Play API. Returns null for notifications that
   * carry no lifecycle change.
   */
  async normalizeServerEvent(raw: unknown): Promise<NormalizedProviderEvent | null> {
    const body = asRecord(raw, 'RTDN push body');
    const message = asRecord(body.message, 'RTDN message');
    const messageId = typeof message.messageId === 'string' ? message.messageId : 'unknown';
    if (typeof message.data !== 'string' || message.data.length === 0) {
      throw badRequest('RTDN push: message.data is required.');
    }
    let decoded: Record<string, unknown>;
    try {
      decoded = asRecord(
        JSON.parse(Buffer.from(message.data, 'base64').toString('utf8')),
        'RTDN data',
      );
    } catch {
      throw badRequest('RTDN push: message.data is not valid base64 JSON.');
    }
    const notification = asRecord(decoded.subscriptionNotification, 'subscriptionNotification');
    const notificationType =
      typeof notification.notificationType === 'number' ? notification.notificationType : -1;
    const purchaseToken = asString(notification.purchaseToken, 'purchaseToken');

    if (typeof decoded.packageName === 'string' && decoded.packageName !== this.cfg.packageName) {
      throw unprocessableEntity('RTDN push: packageName does not match this app.');
    }
    if (IGNORED_RTDN_TYPES.has(notificationType)) return null;
    if (notificationType < 1 || notificationType > 13) {
      throw badRequest(`RTDN push: unknown notificationType ${notificationType}.`);
    }

    // The notification is a hint; the Play API is the truth.
    const { state, facts } = await this.fetchState(purchaseToken);
    let eventType = notificationType;
    // Map the hint onto the fetched state: the state wins when they
    // disagree (e.g. a RENEWED hint arriving after the period lapsed).
    if (notificationType === 4 && state.expiryTimeMillis <= Date.now()) {
      eventType = 13; // treat a stale PURCHASED hint as expired
    }
    return this.buildEvent(purchaseToken, state, `google:rtdn:${messageId}`, facts, eventType);
  }
}
