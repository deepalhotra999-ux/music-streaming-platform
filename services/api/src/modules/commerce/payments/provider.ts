// Phase 30 — provider-neutral commerce payment boundary.
//
// The platform takes money for artist merchandise through exactly one
// seam: `CommercePaymentProvider`. Production providers are added as new
// adapters implementing this interface; the commerce service never talks
// to a provider SDK directly.
//
// Security rules, stated once:
// - The server NEVER accepts a client claim ("I paid", a success callback,
//   a transaction id) as proof of payment. Money moves only on verified
//   provider state: `verifyPayment()` or a signature-verified webhook.
// - No card numbers, CVV, or credentials are ever stored. Only
//   provider-safe references (providerPaymentId, providerRefundId) and
//   transaction metadata live in commerce_payments / commerce_refunds.
// - Webhook processing is idempotent: the same providerEventId is never
//   applied twice (unique constraint + guarded transitions).
//
// The `mock` adapter is the deterministic development/test implementation.
// It performs NO real payment processing, holds NO real credentials, and
// cannot be selected outside development/test (enforced in config.ts).

/** Provider ids the platform knows about. Lowercase at the HTTP boundary. */
export type CommerceProviderId = 'mock';

export const COMMERCE_PROVIDER_IDS: readonly string[] = ['mock'];

export interface CreateCommercePaymentInput {
  /** Our order id (server-generated). */
  orderId: string;
  orderNumber: string;
  /** Integer minor units. */
  amountCents: number;
  /** ISO 4217. */
  currency: string;
  /** Idempotency key for this payment attempt (server-generated). */
  idempotencyKey: string;
  /** Server-derived customer reference (our user id). Never PII. */
  customerRef: string;
}

export type CommercePaymentIntentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface CommercePaymentIntent {
  providerPaymentId: string;
  status: CommercePaymentIntentStatus;
  /**
   * Provider-safe data the client needs to continue the payment (e.g. a
   * mock payment token or a Stripe client_secret). Never secrets that the
   * server must keep — those stay provider-side.
   */
  clientData: Record<string, unknown>;
}

/** Authoritative payment state as reported by the provider. */
export type VerifiedPaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'REFUNDED';

export interface VerifiedPayment {
  providerPaymentId: string;
  status: VerifiedPaymentStatus;
  amountCents: number;
  currency: string;
}

/** Provider-neutral payment lifecycle event, normalized from a webhook. */
export interface NormalizedPaymentEvent {
  /** Idempotency key: unique per provider. Duplicates must not re-apply. */
  providerEventId: string;
  eventType: 'payment.succeeded' | 'payment.failed' | 'payment.canceled' | 'payment.refunded';
  providerPaymentId: string;
  amountCents: number;
  currency: string;
}

export interface CommerceRefundResult {
  providerRefundId: string;
  status: 'SUCCEEDED' | 'FAILED';
}

/**
 * The contract a commerce payment integration implements.
 *
 * `createPaymentIntent` starts a payment attempt for an order.
 *
 * `verifyPayment` is the authoritative status check. The commerce service
 * calls it after any client-side payment completion signal and before
 * marking an order PAID. It must query the provider — never trust input.
 *
 * `verifyWebhookSignature` authenticates a webhook delivery using the
 * provider's documented mechanism (HMAC, JWS, …). The HTTP layer calls it
 * before `normalizeWebhookEvent`; adapters throw on invalid signatures.
 *
 * `normalizeWebhookEvent` converts an already-authenticated webhook payload
 * into a domain event. Returns null for events with no state change.
 *
 * `refundPayment` issues a refund through the provider. Idempotent per
 * idempotencyKey: the same key must return the original refund.
 */
export interface CommercePaymentProvider {
  readonly id: string;
  createPaymentIntent(input: CreateCommercePaymentInput): Promise<CommercePaymentIntent>;
  verifyPayment(providerPaymentId: string): Promise<VerifiedPayment>;
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean;
  normalizeWebhookEvent(raw: unknown): Promise<NormalizedPaymentEvent | null>;
  refundPayment(
    providerPaymentId: string,
    amountCents: number,
    currency: string,
    idempotencyKey: string,
  ): Promise<CommerceRefundResult>;
}
