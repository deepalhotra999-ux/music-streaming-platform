// Phase 30 — payment state application.
//
// The single place where verified provider state moves money. Both the
// client-triggered confirm-payment endpoint and the webhook handler funnel
// through here, so the transition guards cannot drift apart.
//
// Rules:
// - Only verified provider state (verifyPayment / verified webhook event)
//   changes payment or order state. Client callbacks are never trusted.
// - Transitions are guarded: e.g. SUCCEEDED applies only from a non-final
//   payment state and only moves PENDING_PAYMENT orders to PAID.
// - Inventory moves with the money: success converts reserved -> sold,
//   failure/cancellation releases reserved -> available. All inside the
//   same transaction as the state change.
// - Webhook events are recorded in the append-only commerce_payment_events
//   table first; a duplicate providerEventId is acknowledged without
//   re-applying (idempotent).

import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import { recordAuditEvent } from '../audit/service.js';
import type { NormalizedPaymentEvent, VerifiedPayment } from './payments/index.js';

type Db = Prisma.TransactionClient;

export type PaymentApplication = 'succeeded' | 'failed' | 'canceled' | 'refunded';

/**
 * Record a provider event idempotently. Returns false when the event was
 * already recorded (caller should ack without re-applying).
 */
export async function recordPaymentEvent(
  paymentId: string,
  event: NormalizedPaymentEvent,
  db: PrismaClient | Db = prisma,
): Promise<boolean> {
  try {
    await db.commercePaymentEvent.create({
      data: {
        paymentId,
        providerEventId: event.providerEventId,
        eventType: event.eventType,
        payload: { amountCents: event.amountCents, currency: event.currency } as Prisma.InputJsonValue,
      },
    });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return false; // duplicate delivery — already processed
    }
    throw e;
  }
}

/**
 * Move reserved units to sold (payment success) or back to available
 * (payment failure / cancellation / order cancellation).
 */
export async function moveInventory(
  tx: Db,
  orderId: string,
  direction: 'to_sold' | 'release',
): Promise<void> {
  const items = await tx.commerceOrderItem.findMany({
    where: { orderId },
    select: { productId: true, variantId: true, quantity: true },
  });
  for (const item of items) {
    const where = item.variantId
      ? { productId: item.productId, variantId: item.variantId }
      : { productId: item.productId, variantId: null };
    const inv = await tx.inventoryItem.findFirst({ where });
    if (!inv) continue; // defensive: inventory rows are created with products
    if (direction === 'to_sold') {
      await tx.inventoryItem.update({
        where: { id: inv.id },
        data: {
          quantityReserved: { decrement: item.quantity },
          quantitySold: { increment: item.quantity },
          quantityAvailable: { decrement: item.quantity },
        },
      });
    } else {
      await tx.inventoryItem.update({
        where: { id: inv.id },
        data: { quantityReserved: { decrement: item.quantity } },
      });
    }
  }
}

export interface ApplyVerifiedPaymentInput {
  verified: VerifiedPayment;
  /** Null for system/webhook-driven transitions. */
  actorId: string | null;
  /** When true, the event was already recorded (webhook path). */
  eventRecorded?: boolean;
  event?: NormalizedPaymentEvent;
}

export interface ApplyVerifiedPaymentResult {
  paymentStatus: string;
  orderStatus: string;
  applied: boolean;
}

/**
 * Apply verified provider state to a payment + order. Idempotent: applying
 * an already-final state is a no-op ack, never a duplicate transition.
 */
export async function applyVerifiedPayment(
  paymentId: string,
  input: ApplyVerifiedPaymentInput,
): Promise<ApplyVerifiedPaymentResult> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.commercePayment.findUnique({
      where: { id: paymentId },
      include: { order: true },
    });
    if (!payment) throw notFound('Payment not found.');
    if (payment.providerPaymentId !== input.verified.providerPaymentId) {
      // Stale verification for a superseded intent — ignore, do not apply.
      return {
        paymentStatus: payment.status,
        orderStatus: payment.order.status,
        applied: false,
      };
    }
    if (input.event && !input.eventRecorded) {
      const recorded = await recordPaymentEvent(paymentId, input.event, tx);
      if (!recorded) {
        return {
          paymentStatus: payment.status,
          orderStatus: payment.order.status,
          applied: false,
        };
      }
    }

    const status = input.verified.status;
    const order = payment.order;

    if (status === 'SUCCEEDED') {
      if (payment.status === 'SUCCEEDED') {
        return { paymentStatus: payment.status, orderStatus: order.status, applied: false };
      }
      if (payment.status === 'REFUNDED' || payment.status === 'FAILED' || payment.status === 'CANCELED') {
        throw conflict(`Payment is already ${payment.status}; cannot mark succeeded.`);
      }
      if (order.status !== 'PENDING_PAYMENT') {
        throw conflict(`Order is ${order.status}; only PENDING_PAYMENT orders can be paid.`);
      }
      await tx.commercePayment.update({ where: { id: paymentId }, data: { status: 'SUCCEEDED' } });
      await tx.commerceOrder.update({ where: { id: order.id }, data: { status: 'PAID' } });
      await moveInventory(tx, order.id, 'to_sold');
      await recordAuditEvent(
        {
          actorId: input.actorId,
          action: 'commerce.order.paid',
          targetType: 'commerce_order',
          targetId: order.id,
          metadata: {
            orderNumber: order.orderNumber,
            amountCents: payment.amountCents,
            currency: payment.currency,
            provider: payment.provider,
          },
        },
        tx,
      );
      return { paymentStatus: 'SUCCEEDED', orderStatus: 'PAID', applied: true };
    }

    if (status === 'FAILED' || status === 'CANCELED') {
      const target = status === 'FAILED' ? 'FAILED' : 'CANCELED';
      if (payment.status === target || payment.status === 'SUCCEEDED') {
        return { paymentStatus: payment.status, orderStatus: order.status, applied: false };
      }
      await tx.commercePayment.update({ where: { id: paymentId }, data: { status: target } });
      // The order stays PENDING_PAYMENT so the buyer can retry with a fresh
      // intent; reserved units go back to the sellable pool.
      if (order.status === 'PENDING_PAYMENT') {
        await moveInventory(tx, order.id, 'release');
      }
      await recordAuditEvent(
        {
          actorId: input.actorId,
          action: 'commerce.payment.failed',
          targetType: 'commerce_order',
          targetId: order.id,
          metadata: { orderNumber: order.orderNumber, paymentStatus: target },
        },
        tx,
      );
      return { paymentStatus: target, orderStatus: order.status, applied: true };
    }

    if (status === 'REFUNDED') {
      // Provider-driven refund notification (e.g. dashboard refund). Only
      // meaningful when a refund record exists — the refund flow is the
      // authority; this just reconciles provider state.
      const refund = await tx.commerceRefund.findFirst({
        where: { paymentId, status: 'SUCCEEDED' },
      });
      if (!refund) {
        throw badRequest('No succeeded refund exists for this payment.');
      }
      await tx.commercePayment.update({ where: { id: paymentId }, data: { status: 'REFUNDED' } });
      return { paymentStatus: 'REFUNDED', orderStatus: order.status, applied: true };
    }

    // PENDING or unknown: no state change.
    return { paymentStatus: payment.status, orderStatus: order.status, applied: false };
  });
}
