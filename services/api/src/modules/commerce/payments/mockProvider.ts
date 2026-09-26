// Phase 30 — deterministic mock commerce payment provider.
//
// This adapter performs NO real payment processing. It exists so commerce
// can be developed, tested, and demoed without live payment credentials,
// exactly like the Phase 18 DEV subscription adapter.
//
// Deterministic behavior (all in-memory, per process):
// - `createPaymentIntent` mints `mock_pi_<n>` in PENDING state.
// - `setScenario(providerPaymentId, outcome)` presets what the provider
//   will report. Outcomes: 'succeeded' | 'failed' | 'canceled'. Unset
//   intents verify as PENDING.
// - `completePayment(providerPaymentId)` applies the preset scenario (or
//   'succeeded' when none is set), simulating the buyer finishing payment
//   in the provider's UI. The commerce service still re-verifies via
//   `verifyPayment()` before moving money — the completion is provider
//   state, not a client claim.
// - Webhooks are HMAC-SHA256 signed with the configured mock secret,
//   demonstrating the signature-verification pattern a production adapter
//   must implement (Stripe: `Stripe-Signature`; Apple/Google: JWS).
//
// Production requirements (documented, not implemented): a real adapter
// must verify purchase state against the provider's API, validate webhook
// signatures with the provider's documented mechanism, and never accept
// client-supplied payment claims.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CommercePaymentIntent,
  CommercePaymentProvider,
  CommerceRefundResult,
  CreateCommercePaymentInput,
  NormalizedPaymentEvent,
  VerifiedPayment,
  VerifiedPaymentStatus,
} from './provider.js';

type MockOutcome = 'succeeded' | 'failed' | 'canceled';

interface MockIntent {
  providerPaymentId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  status: VerifiedPaymentStatus;
  scenario: MockOutcome | null;
}

interface MockRefund {
  providerRefundId: string;
  providerPaymentId: string;
  amountCents: number;
  status: 'SUCCEEDED' | 'FAILED';
}

const intents = new Map<string, MockIntent>();
const refundsByKey = new Map<string, MockRefund>();
let intentCounter = 0;
let refundCounter = 0;
let eventCounter = 0;
const mockProcessId = Date.now().toString(36);

export function resetMockPaymentState(): void {
  intents.clear();
  refundsByKey.clear();
  intentCounter = 0;
  refundCounter = 0;
  eventCounter = 0;
}

/**
 * Test/dev hook: preset the outcome the mock provider will report for an
 * intent. In production this is the buyer's action in the provider UI.
 */
export function setMockPaymentScenario(providerPaymentId: string, outcome: MockOutcome): void {
  const intent = intents.get(providerPaymentId);
  if (!intent) throw new Error(`Unknown mock payment intent: ${providerPaymentId}`);
  intent.scenario = outcome;
}

/**
 * Simulate the buyer completing (or abandoning) payment in the provider UI.
 * Applies the preset scenario, defaulting to 'succeeded'. Returns the new
 * provider-side status. The commerce service MUST still call
 * verifyPayment() — this function only changes mock provider state.
 */
export function completeMockPayment(providerPaymentId: string): VerifiedPaymentStatus {
  const intent = intents.get(providerPaymentId);
  if (!intent) throw new Error(`Unknown mock payment intent: ${providerPaymentId}`);
  const outcome = intent.scenario ?? 'succeeded';
  intent.status = outcome === 'succeeded' ? 'SUCCEEDED' : outcome === 'failed' ? 'FAILED' : 'CANCELED';
  return intent.status;
}

/** Build a correctly-signed mock webhook payload for an intent event. */
export function buildMockWebhookPayload(
  providerPaymentId: string,
  eventType: NormalizedPaymentEvent['eventType'],
  secret: string,
): { body: string; signature: string } {
  const intent = intents.get(providerPaymentId);
  if (!intent) throw new Error(`Unknown mock payment intent: ${providerPaymentId}`);
  eventCounter += 1;
  // Globally unique like a real provider's event ids: the test database
  // persists payment events across runs, so a bare per-process counter
  // would collide with rows from earlier runs.
  const body = JSON.stringify({
    id: `mock_evt_${mockProcessId}_${eventCounter}`,
    type: eventType,
    data: {
      paymentId: providerPaymentId,
      amountCents: intent.amountCents,
      currency: intent.currency,
    },
  });
  const signature = `t=${Date.now()},v1=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return { body, signature };
}

function parseSignature(signature: string | undefined): { t: string; v1: string } | null {
  if (!signature) return null;
  const parts = Object.fromEntries(signature.split(',').map((p) => p.split('=')));
  if (typeof parts.t !== 'string' || typeof parts.v1 !== 'string') return null;
  return { t: parts.t, v1: parts.v1 };
}

export class MockPaymentProvider implements CommercePaymentProvider {
  readonly id = 'mock';
  private readonly webhookSecret: string;

  constructor(webhookSecret: string) {
    this.webhookSecret = webhookSecret;
  }

  async createPaymentIntent(input: CreateCommercePaymentInput): Promise<CommercePaymentIntent> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      throw new Error('Mock provider: amountCents must be a positive integer.');
    }
    intentCounter += 1;
    const providerPaymentId = `mock_pi_${mockProcessId}_${intentCounter}_${input.orderId.slice(0, 8)}`;
    intents.set(providerPaymentId, {
      providerPaymentId,
      orderId: input.orderId,
      amountCents: input.amountCents,
      currency: input.currency,
      status: 'PENDING',
      scenario: null,
    });
    return {
      providerPaymentId,
      status: 'PENDING',
      // Provider-safe: a mock token the dev client displays. In production
      // this would be e.g. a Stripe client_secret — still not a credential
      // the server stores.
      clientData: { mockPaymentToken: providerPaymentId },
    };
  }

  async verifyPayment(providerPaymentId: string): Promise<VerifiedPayment> {
    const intent = intents.get(providerPaymentId);
    if (!intent) {
      throw new Error(`Mock provider: unknown payment ${providerPaymentId}.`);
    }
    return {
      providerPaymentId,
      status: intent.status,
      amountCents: intent.amountCents,
      currency: intent.currency,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    const parsed = parseSignature(signature);
    if (!parsed) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const a = Buffer.from(parsed.v1, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async normalizeWebhookEvent(raw: unknown): Promise<NormalizedPaymentEvent | null> {
    if (typeof raw !== 'object' || raw === null) return null;
    const evt = raw as Record<string, unknown>;
    if (typeof evt.id !== 'string' || typeof evt.type !== 'string') return null;
    const data = evt.data as Record<string, unknown> | undefined;
    if (!data || typeof data.paymentId !== 'string') return null;
    const type = evt.type;
    if (
      type !== 'payment.succeeded' &&
      type !== 'payment.failed' &&
      type !== 'payment.canceled' &&
      type !== 'payment.refunded'
    ) {
      return null;
    }
    const intent = intents.get(data.paymentId);
    return {
      providerEventId: evt.id,
      eventType: type,
      providerPaymentId: data.paymentId,
      amountCents:
        typeof data.amountCents === 'number' ? data.amountCents : (intent?.amountCents ?? 0),
      currency: typeof data.currency === 'string' ? data.currency : (intent?.currency ?? 'USD'),
    };
  }

  async refundPayment(
    providerPaymentId: string,
    amountCents: number,
    currency: string,
    idempotencyKey: string,
  ): Promise<CommerceRefundResult> {
    const existing = refundsByKey.get(idempotencyKey);
    if (existing) return { providerRefundId: existing.providerRefundId, status: existing.status };
    const intent = intents.get(providerPaymentId);
    if (!intent) throw new Error(`Mock provider: unknown payment ${providerPaymentId}.`);
    if (intent.status !== 'SUCCEEDED' && intent.status !== 'REFUNDED') {
      throw new Error('Mock provider: only succeeded payments can be refunded.');
    }
    // Phase 30 supports full refunds only; the mock enforces it like a
    // production adapter would enforce its own rules.
    if (amountCents !== intent.amountCents || currency !== intent.currency) {
      throw new Error('Mock provider: Phase 30 supports full refunds only (amount must match).');
    }
    refundCounter += 1;
    const refund: MockRefund = {
      providerRefundId: `mock_re_${refundCounter}_${providerPaymentId.slice(8, 16)}`,
      providerPaymentId,
      amountCents,
      status: 'SUCCEEDED',
    };
    refundsByKey.set(idempotencyKey, refund);
    if (intent.status === 'SUCCEEDED') intent.status = 'REFUNDED';
    return { providerRefundId: refund.providerRefundId, status: refund.status };
  }
}
