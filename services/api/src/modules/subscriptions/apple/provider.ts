// Phase 19 — Apple App Store adapter.
//
// Two integration points, both server-side:
//
//  1. App Store Server API — verifies a client-supplied purchase token.
//     The token is either a signed transaction JWS (verified locally
//     against Apple's chain, then the authoritative current state is
//     fetched) or a bare transaction id (the API response's signed payload
//     is verified instead). Client input is NEVER trusted on its own.
//  2. App Store Server Notifications v2 — the notification body's
//     `signedPayload` JWS is verified against Apple's chain before any
//     field is read. Unverifiable payloads are rejected (422), malformed
//     ones (400).
//
// Environment: `sandbox` uses api.storekit-sandbox.itunes.apple.com,
// `production` uses api.storekit.itunes.apple.com.

import * as jose from 'jose';
import type { PrismaClient } from '@prisma/client';
import { badRequest, serviceUnavailable, unprocessableEntity } from '../../../http/errors.js';
import type { AppleStoreConfig } from '../../../config.js';
import { resolvePlanByStoreProduct } from '../productMapping.js';
import type { NormalizedProviderEvent, SubscriptionProviderAdapter } from '../providers.js';
import { verifyAppleSignedPayload } from './jws.js';
import { resolveFetch, type FetchImpl } from '../fetchOverride.js';

const SANDBOX_HOST = 'https://api.storekit-sandbox.itunes.apple.com';
const PRODUCTION_HOST = 'https://api.storekit.itunes.apple.com';

/** Notification types that carry no lifecycle change — acknowledge, ignore. */
const IGNORED_NOTIFICATION_TYPES = new Set([
  'CONSUMPTION_REQUEST',
  'TEST',
  'PRICE_INCREASE_CONSENT',
  'DID_CHANGE_RENEWAL_PREF',
  'RENEWAL_EXTENSION_SUMMARY',
]);

interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId?: string;
  purchaseDate: number;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
  environment?: string;
}

interface AppleRenewalInfo {
  autoRenewStatus?: number;
  autoRenewProductId?: string;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`Apple payload: "${field}" must be a non-empty string.`);
  }
  return value;
}

function asOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function parseTransaction(payload: Record<string, unknown>): AppleTransaction {
  return {
    transactionId: asString(payload.transactionId, 'transactionId'),
    originalTransactionId: asString(payload.originalTransactionId, 'originalTransactionId'),
    productId: asString(payload.productId, 'productId'),
    bundleId: typeof payload.bundleId === 'string' ? payload.bundleId : undefined,
    purchaseDate: asOptionalNumber(payload.purchaseDate) ?? 0,
    expiresDate: asOptionalNumber(payload.expiresDate),
    revocationDate: asOptionalNumber(payload.revocationDate),
    appAccountToken:
      typeof payload.appAccountToken === 'string' ? payload.appAccountToken : undefined,
    environment: typeof payload.environment === 'string' ? payload.environment : undefined,
  };
}

function parseRenewalInfo(payload: Record<string, unknown>): AppleRenewalInfo {
  const autoRenewStatus = asOptionalNumber(payload.autoRenewStatus);
  return {
    autoRenewStatus: autoRenewStatus === 0 || autoRenewStatus === 1 ? autoRenewStatus : undefined,
    autoRenewProductId:
      typeof payload.autoRenewProductId === 'string' ? payload.autoRenewProductId : undefined,
  };
}

export class AppleStoreAdapter implements SubscriptionProviderAdapter {
  readonly id = 'apple' as const;
  private readonly host: string;
  private readonly fetchImpl: FetchImpl;
  private clientJwt: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly cfg: AppleStoreConfig,
    private readonly db: PrismaClient,
    fetchImpl?: FetchImpl,
  ) {
    if (!cfg.enabled) {
      throw serviceUnavailable('Apple App Store billing is not configured on this server.');
    }
    this.host = cfg.environment === 'production' ? PRODUCTION_HOST : SANDBOX_HOST;
    this.fetchImpl = resolveFetch(fetchImpl);
  }

  // --- App Store Server API -------------------------------------------------

  private async clientToken(): Promise<string> {
    const now = Date.now();
    if (this.clientJwt && this.clientJwt.expiresAt - 60_000 > now) {
      return this.clientJwt.token;
    }
    const privateKey = await jose.importPKCS8(this.cfg.privateKeyPem!, 'ES256');
    const token = await new jose.SignJWT({ bid: this.cfg.bundleId! })
      .setProtectedHeader({ alg: 'ES256', kid: this.cfg.keyId!, typ: 'JWT' })
      .setIssuer(this.cfg.issuerId!)
      .setAudience('appstoreconnect-v1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    this.clientJwt = { token, expiresAt: now + 3_600_000 };
    return token;
  }

  private async apiGet(path: string): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.host}${path}`, {
      headers: { Authorization: `Bearer ${await this.clientToken()}` },
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw unprocessableEntity('Apple could not find that transaction.');
      }
      throw serviceUnavailable(`App Store Server API error (HTTP ${res.status}).`);
    }
    return asRecord(await res.json(), 'App Store Server API response');
  }

  private async verifiedTransactionJws(signedJws: unknown): Promise<AppleTransaction> {
    const { payload } = verifyAppleSignedPayload(asString(signedJws, 'signedTransactionInfo'));
    return parseTransaction(payload);
  }

  /** Authoritative current truth for one transaction id. */
  private async fetchTransactionState(transactionId: string): Promise<{
    transaction: AppleTransaction;
    renewal: AppleRenewalInfo | null;
    subscriptionStatus: string | null;
  }> {
    const txBody = await this.apiGet(`/inApps/v1/transactions/${transactionId}`);
    const transaction = await this.verifiedTransactionJws(txBody.signedTransactionInfo);

    let renewal: AppleRenewalInfo | null = null;
    let subscriptionStatus: string | null = null;
    try {
      const subBody = await this.apiGet(
        `/inApps/v1/subscriptions/${transaction.originalTransactionId}`,
      );
      const lastTransactions = subBody.lastTransactions;
      if (Array.isArray(lastTransactions)) {
        const match = lastTransactions.find((entry) => {
          if (typeof entry !== 'object' || entry === null) return false;
          const e = entry as Record<string, unknown>;
          return typeof e.originalTransactionId === 'string'
            ? e.originalTransactionId === transaction.originalTransactionId
            : false;
        }) as Record<string, unknown> | undefined;
        const entry = match ?? (lastTransactions[0] as Record<string, unknown> | undefined);
        if (entry) {
          if (typeof entry.status === 'string') subscriptionStatus = entry.status;
          if (entry.signedRenewalInfo) {
            const { payload } = verifyAppleSignedPayload(
              asString(entry.signedRenewalInfo, 'signedRenewalInfo'),
            );
            renewal = parseRenewalInfo(payload);
          }
        }
      }
    } catch {
      // The subscriptions endpoint is a best-effort enrichment; the verified
      // transaction itself is authoritative for period and product.
      renewal = null;
    }
    return { transaction, renewal, subscriptionStatus };
  }

  // --- Event construction ---------------------------------------------------

  private async buildEvent(
    transaction: AppleTransaction,
    providerEventId: string,
    renewal: AppleRenewalInfo | null,
    subscriptionStatus: string | null,
    notificationType?: string,
    notificationSubtype?: string,
  ): Promise<NormalizedProviderEvent> {
    // App binding: a valid Apple transaction from another app must be
    // rejected. The bundleId in the signed transaction must match our
    // configured bundle id.
    if (this.cfg.bundleId && transaction.bundleId && transaction.bundleId !== this.cfg.bundleId) {
      throw unprocessableEntity(
        `Apple transaction is for a different app ("${transaction.bundleId}").`,
      );
    }
    // Environment binding: sandbox transactions are only accepted when the
    // adapter is configured for sandbox, and vice versa.
    const expectedEnv = this.cfg.environment === 'production' ? 'Production' : 'Sandbox';
    if (transaction.environment && transaction.environment !== expectedEnv) {
      throw unprocessableEntity(
        `Apple transaction environment "${transaction.environment}" does not match expected "${expectedEnv}".`,
      );
    }
    const mapping = await resolvePlanByStoreProduct('APPLE', transaction.productId, this.db);
    const now = Date.now();
    const periodStart = new Date(transaction.purchaseDate);
    const periodEnd =
      transaction.expiresDate !== undefined ? new Date(transaction.expiresDate) : undefined;

    let eventType: NormalizedProviderEvent['eventType'];
    const facts: Record<string, string> = {
      storeProductId: transaction.productId,
      transactionId: transaction.transactionId,
    };
    if (notificationType) {
      facts.notificationType = notificationType;
      if (notificationSubtype) facts.notificationSubtype = notificationSubtype;
    }

    if (transaction.revocationDate !== undefined) {
      eventType = 'SUBSCRIPTION_REVOKED';
      facts.revocationDate = new Date(transaction.revocationDate).toISOString();
    } else if (notificationType === 'SUBSCRIBED') {
      // INITIAL_BUY and RESUBSCRIBE both mean "currently paid". A resubscribe
      // after expiry reuses the original transaction id, so it normalizes to
      // a renewal — the service may resurrect EXPIRED rows for verified
      // renewals, but REVOKED stays terminal.
      eventType = 'RENEWAL_SUCCEEDED';
    } else if (notificationType === 'DID_RENEW' || notificationType === 'RENEWAL_EXTENDED') {
      eventType = 'RENEWAL_SUCCEEDED';
    } else if (notificationType === 'DID_FAIL_TO_RENEW') {
      eventType = 'SUBSCRIPTION_GRACE_PERIOD';
    } else if (notificationType === 'EXPIRED') {
      eventType = 'SUBSCRIPTION_EXPIRED';
    } else if (notificationType === 'DID_CHANGE_RENEWAL_STATUS') {
      eventType = renewal?.autoRenewStatus === 0 ? 'SUBSCRIPTION_CANCELED' : 'RENEWAL_SUCCEEDED';
    } else if (notificationType === 'REFUND' || notificationType === 'REVOKE') {
      eventType = 'SUBSCRIPTION_REVOKED';
    } else if (subscriptionStatus === 'EXPIRED' || (periodEnd && periodEnd.getTime() <= now)) {
      eventType = 'SUBSCRIPTION_EXPIRED';
    } else if (subscriptionStatus === 'GRACE_PERIOD') {
      eventType = 'SUBSCRIPTION_GRACE_PERIOD';
    } else if (subscriptionStatus === 'BILLING_RETRY') {
      eventType = 'PAYMENT_FAILED';
    } else if (renewal?.autoRenewStatus === 0) {
      eventType = 'SUBSCRIPTION_CANCELED';
    } else {
      eventType = 'RENEWAL_SUCCEEDED';
    }

    return {
      providerEventId,
      eventType,
      externalSubscriptionId: transaction.originalTransactionId,
      planCode: mapping.planCode,
      periodStart,
      periodEnd,
      verified: true,
      appAccountUserId: transaction.appAccountToken,
      facts,
    };
  }

  // --- Adapter contract -----------------------------------------------------

  /**
   * Verify a client-supplied purchase token. Accepts a signed transaction
   * JWS (verified locally, then enriched from the API) or a bare
   * transaction id (the API's signed payload is verified instead).
   */
  async verifyPurchase(purchaseToken: string): Promise<NormalizedProviderEvent> {
    if (
      typeof purchaseToken !== 'string' ||
      purchaseToken.length === 0 ||
      purchaseToken.length > 8192
    ) {
      throw badRequest('purchaseToken must be a non-empty string.');
    }
    let transactionId = purchaseToken;
    const looksLikeJws = purchaseToken.split('.').length === 3;
    if (looksLikeJws) {
      // Local verification first: establishes authenticity before any fetch.
      const { payload } = verifyAppleSignedPayload(purchaseToken);
      transactionId = parseTransaction(payload).transactionId;
    }
    const { transaction, renewal, subscriptionStatus } =
      await this.fetchTransactionState(transactionId);
    return this.buildEvent(
      transaction,
      `apple:client-verify:${transaction.transactionId}`,
      renewal,
      subscriptionStatus,
    );
  }

  /**
   * Normalize an App Store Server Notification v2 body
   * (`{ signedPayload }`). Returns null for notifications that carry no
   * lifecycle change (consumption requests, test pings, price-consent …).
   */
  async normalizeServerEvent(raw: unknown): Promise<NormalizedProviderEvent | null> {
    const body = asRecord(raw, 'notification body');
    const signedPayload = body.signedPayload;
    if (typeof signedPayload !== 'string' || signedPayload.length === 0) {
      throw badRequest('Apple notification: "signedPayload" is required.');
    }
    const { payload } = verifyAppleSignedPayload(signedPayload);
    const notificationType =
      typeof payload.notificationType === 'string' ? payload.notificationType : '';
    const notificationSubtype = typeof payload.subtype === 'string' ? payload.subtype : undefined;
    const notificationUUID =
      typeof payload.notificationUUID === 'string' ? payload.notificationUUID : '';

    if (!notificationType) throw badRequest('Apple notification: missing notificationType.');
    if (IGNORED_NOTIFICATION_TYPES.has(notificationType)) return null;
    if (!notificationUUID) throw badRequest('Apple notification: missing notificationUUID.');

    const data = asRecord(payload.data, 'notification data');
    const transaction = await this.verifiedTransactionJws(data.signedTransactionInfo);
    let renewal: AppleRenewalInfo | null = null;
    if (typeof data.signedRenewalInfo === 'string') {
      const { payload: renewalPayload } = verifyAppleSignedPayload(data.signedRenewalInfo);
      renewal = parseRenewalInfo(renewalPayload);
    }
    return this.buildEvent(
      transaction,
      `apple:${notificationUUID}`,
      renewal,
      null,
      notificationType,
      notificationSubtype,
    );
  }
}
