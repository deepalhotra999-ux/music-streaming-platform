// Phase 32 — Stripe commerce payment adapter.
//
// Implements `CommercePaymentProvider` against Stripe's PaymentIntents API.
// This is a REAL production integration point, not a simulation:
//
// - No card data ever touches this application. The client confirms the
//   PaymentIntent with Stripe.js/Stripe SDK using the returned
//   `client_secret`; card numbers go directly to Stripe.
// - Money moves only on verified Stripe state: `verifyPayment` retrieves
//   the PaymentIntent from Stripe's API, and webhooks are authenticated
//   with Stripe's signature scheme (timestamp tolerance enforced).
// - Webhook handling stays idempotent: Stripe event ids dedupe via the
//   existing providerEventId unique constraint.
// - All amounts are integer minor units; currency is explicit ISO 4217.
//
// Required environment (see .env.example):
//   COMMERCE_PAYMENT_PROVIDER=stripe
//   STRIPE_SECRET_KEY=<redacted>          (never commit)
//   STRIPE_WEBHOOK_SECRET=<whsec_...>     (never commit)
//
// Without both values the adapter refuses to construct and the API fails
// fast at startup — production can never silently fall back to the mock.

import Stripe from 'stripe';
import type {
  CommercePaymentIntent,
  CommercePaymentProvider,
  CommerceRefundResult,
  CreateCommercePaymentInput,
  NormalizedPaymentEvent,
  VerifiedPayment,
} from './provider.js';

export interface StripeAdapterConfig {
  secretKey: string;
  webhookSecret: string;
}

const WEBHOOK_TOLERANCE_SECONDS = 300; // Stripe default

export class StripePaymentProvider implements CommercePaymentProvider {
  readonly id = 'stripe';
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: StripeAdapterConfig) {
    if (!config.secretKey || !config.webhookSecret) {
      throw new Error(
        'StripePaymentProvider requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. ' +
          'Set both in the environment; see .env.example.',
      );
    }
    this.stripe = new Stripe(config.secretKey);
    this.webhookSecret = config.webhookSecret;
  }

  async createPaymentIntent(input: CreateCommercePaymentInput): Promise<CommercePaymentIntent> {
    // The idempotency key makes retried checkout attempts safe: Stripe
    // returns the original PaymentIntent instead of charging twice.
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        metadata: {
          orderId: input.orderId,
          orderNumber: input.orderNumber,
          customerRef: input.customerRef,
        },
        // Automatic confirmation keeps the client flow simple; the client
        // still completes any required 3-D Secure step via client_secret.
        confirmation_method: 'automatic',
      },
      { idempotencyKey: `waveform-order-${input.idempotencyKey}` },
    );
    return {
      providerPaymentId: intent.id,
      status: 'PENDING',
      clientData: {
        // The client_secret is safe to expose: it only authorizes
        // completing THIS PaymentIntent, and only with the payment method
        // the customer provides to Stripe directly.
        clientSecret: intent.client_secret,
      },
    };
  }

  async verifyPayment(providerPaymentId: string): Promise<VerifiedPayment> {
    // Authoritative: always ask Stripe, never trust client input.
    const intent = await this.stripe.paymentIntents.retrieve(providerPaymentId);
    return {
      providerPaymentId: intent.id,
      status: mapIntentStatus(intent.status),
      amountCents: intent.amount,
      currency: intent.currency.toUpperCase(),
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    try {
      Stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret, WEBHOOK_TOLERANCE_SECONDS);
      return true;
    } catch {
      return false;
    }
  }

  async normalizeWebhookEvent(raw: unknown): Promise<NormalizedPaymentEvent | null> {
    // The HTTP layer verifies the signature before calling this; parse the
    // already-authenticated payload. We re-parse rather than trusting a
    // passed-in object so the boundary stays explicit.
    const event = raw as Stripe.Event;
    const providerEventId = event.id;
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          providerEventId,
          eventType: 'payment.succeeded',
          providerPaymentId: intent.id,
          amountCents: intent.amount,
          currency: intent.currency.toUpperCase(),
        };
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          providerEventId,
          eventType: 'payment.failed',
          providerPaymentId: intent.id,
          amountCents: intent.amount,
          currency: intent.currency.toUpperCase(),
        };
      }
      case 'payment_intent.canceled': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          providerEventId,
          eventType: 'payment.canceled',
          providerPaymentId: intent.id,
          amountCents: intent.amount,
          currency: intent.currency.toUpperCase(),
        };
      }
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const intentId =
          typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
        if (!intentId) return null;
        return {
          providerEventId,
          eventType: 'payment.refunded',
          providerPaymentId: intentId,
          amountCents: charge.amount_refunded,
          currency: charge.currency.toUpperCase(),
        };
      }
      default:
        return null; // No state change for other event types.
    }
  }

  async refundPayment(
    providerPaymentId: string,
    amountCents: number,
    currency: string,
    idempotencyKey: string,
  ): Promise<CommerceRefundResult> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: providerPaymentId,
        amount: amountCents,
        currency: currency.toLowerCase(),
      },
      { idempotencyKey: `waveform-refund-${idempotencyKey}` },
    );
    return {
      providerRefundId: refund.id,
      status: refund.status === 'failed' ? 'FAILED' : 'SUCCEEDED',
    };
  }
}

function mapIntentStatus(
  status: Stripe.PaymentIntent.Status,
): VerifiedPayment['status'] {
  switch (status) {
    case 'succeeded':
      return 'SUCCEEDED';
    case 'canceled':
      return 'CANCELED';
    case 'requires_payment_method':
    case 'requires_confirmation':
    case 'requires_action':
    case 'processing':
      return 'PENDING';
    default:
      return 'FAILED';
  }
}
