// Phase 30 — orders: server-authoritative checkout, payment confirmation,
// cancellation, fulfillment, and refunds.
//
// Checkout flow (all inside ONE database transaction):
//  1. Authenticate (route layer). 2. Idempotency check. 3. Re-read the cart.
//  4. Enforce single-store (multi-artist carts are checked out per store).
//  5. Validate product + store status. 6. Recompute prices server-side
//     (client prices do not exist — cart lines carry no prices).
//  7. Atomically reserve inventory (single UPDATE with availability guard;
//     two buyers racing for the last unit cannot both win).
//  8. Create the order + immutable item snapshots + shipping address.
//  9. Create the payment intent through the provider-neutral boundary.
//  10. Clear the cart. 11. Audit.
//
// Money moves ONLY on verified provider state (verifyPayment / verified
// webhook), applied through paymentState.ts. A client "payment succeeded"
// callback triggers verification — it never grants PAID directly.
//
// Commerce is isolated from royalties, subscriptions, playback, and the AI
// discovery layer: no shared tables, no shared code paths.

import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../db.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unprocessableEntity,
} from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import { isAdmin } from '../../http/authorization.js';
import { recordAuditEvent } from '../audit/service.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';
import type { CommercePaymentProvider } from './payments/index.js';
import { applyVerifiedPayment, moveInventory } from './paymentState.js';
import { canManageStore, canOperateStore } from './service.js';

type Db = Prisma.TransactionClient;

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELED'
  | 'REFUNDED';

export interface ShippingAddressInput {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postal: string;
  country: string;
  phone?: string;
}

export interface OrderItemDto {
  id: string;
  productId: string;
  variantId: string | null;
  productTitle: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  unitPriceCents: number;
  currency: string;
}

export interface OrderDto {
  id: string;
  orderNumber: string;
  storeId: string;
  storeName: string;
  status: OrderStatus;
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  items: OrderItemDto[];
  payment: {
    provider: string;
    providerPaymentId: string;
    status: string;
    amountCents: number;
    currency: string;
    /** Provider-safe client data for continuing the payment. */
    clientData?: Record<string, unknown>;
  } | null;
  /**
   * Shipping address. Present for the buyer, the store owner (fulfillment),
   * and ADMIN. Never on public surfaces.
   */
  shippingAddress: ShippingAddressInput | null;
  /** Buyer display name — store owner / admin views only. */
  buyerName?: string;
  createdAt: Date;
  updatedAt: Date;
}

type OrderRow = {
  id: string;
  orderNumber: string;
  storeId: string;
  status: OrderStatus;
  currency: string;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  shippingName: string | null;
  shippingLine1: string | null;
  shippingLine2: string | null;
  shippingCity: string | null;
  shippingRegion: string | null;
  shippingPostal: string | null;
  shippingCountry: string | null;
  shippingPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
  store: { id: string; name: string };
  items: {
    id: string;
    productId: string;
    variantId: string | null;
    productTitle: string;
    variantName: string | null;
    sku: string | null;
    quantity: number;
    unitPriceCents: number;
    currency: string;
  }[];
  payments: {
    provider: string;
    providerPaymentId: string;
    status: string;
    amountCents: number;
    currency: string;
  }[];
  user: { displayName: string };
};

const orderInclude = {
  store: { select: { id: true, name: true } },
  items: true,
  payments: {
    select: {
      provider: true,
      providerPaymentId: true,
      status: true,
      amountCents: true,
      currency: true,
    },
  },
  user: { select: { displayName: true } },
} as const;

function toOrderDto(
  row: OrderRow,
  opts: { includeAddress: boolean; includeBuyerName: boolean; clientData?: Record<string, unknown> },
): OrderDto {
  const payment = row.payments[0];
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    storeId: row.storeId,
    storeName: row.store.name,
    status: row.status,
    currency: row.currency,
    subtotalCents: row.subtotalCents,
    shippingCents: row.shippingCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    items: row.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      variantId: i.variantId,
      productTitle: i.productTitle,
      variantName: i.variantName,
      sku: i.sku,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      currency: i.currency,
    })),
    payment: payment
      ? {
          provider: payment.provider,
          providerPaymentId: payment.providerPaymentId,
          status: payment.status,
          amountCents: payment.amountCents,
          currency: payment.currency,
          ...(opts.clientData ? { clientData: opts.clientData } : {}),
        }
      : null,
    shippingAddress:
      opts.includeAddress && row.shippingLine1
        ? {
            name: row.shippingName ?? '',
            line1: row.shippingLine1,
            line2: row.shippingLine2 ?? undefined,
            city: row.shippingCity ?? '',
            region: row.shippingRegion ?? undefined,
            postal: row.shippingPostal ?? '',
            country: row.shippingCountry ?? '',
            phone: row.shippingPhone ?? undefined,
          }
        : null,
    ...(opts.includeBuyerName ? { buyerName: row.user.displayName } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertAddress(input: ShippingAddressInput): void {
  const req: [string, string][] = [
    ['name', input.name],
    ['line1', input.line1],
    ['city', input.city],
    ['postal', input.postal],
    ['country', input.country],
  ];
  for (const [field, value] of req) {
    if (!value || !value.trim() || value.length > 200) {
      throw badRequest(`Shipping address ${field} is required (max 200 chars).`);
    }
  }
  if (input.country.trim().length !== 2) {
    throw badRequest('Shipping address country must be a 2-letter ISO code.');
  }
}

interface CheckoutLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  unitPriceCents: number;
  currency: string;
  productTitle: string;
  variantName: string | null;
  sku: string | null;
}

/**
 * Atomically reserve `quantity` units of one purchasable. Returns false
 * when insufficient stock remains — the single UPDATE is the concurrency
 * guard, so overselling is impossible even under race.
 */
async function reserveInventory(
  tx: Db,
  productId: string,
  variantId: string | null,
  quantity: number,
): Promise<boolean> {
  const where = variantId ? { productId, variantId } : { productId, variantId: null };
  const inv = await tx.inventoryItem.findFirst({ where });
  if (!inv) return false;
  // available = physical on-hand; reserved = earmarked for unpaid orders.
  // The single UPDATE is the concurrency guard: free stock
  // (available - reserved) is checked and decremented atomically.
  const updated = await tx.$executeRaw`
    UPDATE "inventory_items"
    SET "quantity_reserved" = "quantity_reserved" + ${quantity},
        "updated_at" = NOW()
    WHERE "id" = ${inv.id}::uuid
      AND "quantity_available" - "quantity_reserved" >= ${quantity}`;
  return updated === 1;
}

// -------------------------------------------------------------- checkout ---

export interface CheckoutInput {
  idempotencyKey: string;
  shippingAddress: ShippingAddressInput;
}

export async function checkout(
  user: AuthUser,
  input: CheckoutInput,
  provider: CommercePaymentProvider,
): Promise<{ order: OrderDto; created: boolean; clientData: Record<string, unknown> }> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 128) {
    throw badRequest('idempotencyKey is required (max 128 chars).');
  }
  assertAddress(input.shippingAddress);

  return prisma.$transaction(async (tx) => {
    // Idempotency: a retried checkout with the same key returns the
    // original order — never a second order, never a double charge.
    const existing = await tx.commerceOrder.findUnique({
      where: {
        userId_idempotencyKey: { userId: user.id, idempotencyKey: input.idempotencyKey },
      },
      include: orderInclude,
    });
    if (existing) {
      return {
        order: toOrderDto(existing as unknown as OrderRow, {
          includeAddress: true,
          includeBuyerName: false,
        }),
        created: false,
        // Replay: the client already has the provider payment reference in
        // order.payment.providerPaymentId; no new client data is minted.
        clientData: {},
      };
    }

    const cart = await tx.cart.findUnique({
      where: { userId: user.id },
      include: {
        items: {
          include: {
            product: {
              include: {
                store: true,
                variants: { select: { id: true, name: true, priceCents: true, currency: true, sku: true } },
              },
            },
            variant: { select: { id: true, name: true, priceCents: true, currency: true, sku: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const lines = cart?.items ?? [];
    if (lines.length === 0) throw unprocessableEntity('Your cart is empty.');

    // Single-store enforcement: Phase 30 does not build marketplace
    // settlement. The cart groups lines by store so the client can check
    // out each store separately.
    const storeIds = new Set(lines.map((l) => l.product.storeId));
    if (storeIds.size > 1) {
      throw unprocessableEntity(
        'Your cart contains products from multiple stores. ' +
          'Check out one store at a time — the cart view groups items by store.',
      );
    }

    const store = lines[0]!.product.store;
    if (store.status !== 'ACTIVE') {
      throw unprocessableEntity('This store is not currently accepting orders.');
    }

    // Server-side validation + price recomputation. The client submits no
    // prices — cart lines carry only product/variant references.
    const checkoutLines: CheckoutLine[] = [];
    let currency: string | null = null;
    for (const line of lines) {
      const p = line.product;
      if (p.status !== 'ACTIVE') {
        throw unprocessableEntity(`"${p.title}" is no longer available.`);
      }
      let unitPriceCents: number;
      let variantName: string | null = null;
      if (line.variantId) {
        const v = p.variants.find((vv) => vv.id === line.variantId);
        if (!v) throw badRequest(`A variant of "${p.title}" is no longer available.`);
        unitPriceCents = v.priceCents;
        variantName = v.name;
        if (v.currency !== store.currency) {
          throw unprocessableEntity('Currency mismatch on variant.');
        }
      } else {
        if (p.variants.length > 0) {
          throw unprocessableEntity(`"${p.title}" requires a variant selection.`);
        }
        unitPriceCents = p.priceCents;
      }
      if (p.currency !== store.currency) {
        throw unprocessableEntity('Currency mismatch on product.');
      }
      currency = store.currency;
      checkoutLines.push({
        productId: p.id,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceCents,
        currency: store.currency,
        productTitle: p.title,
        variantName,
        sku: line.variantId
          ? (p.variants.find((vv) => vv.id === line.variantId)?.sku ?? null)
          : (p.sku ?? null),
      });
    }

    // Atomic inventory reservation — the oversell guard.
    for (const cl of checkoutLines) {
      const ok = await reserveInventory(tx, cl.productId, cl.variantId, cl.quantity);
      if (!ok) {
        throw conflict(
          `Insufficient stock for "${cl.productTitle}"${cl.variantName ? ` (${cl.variantName})` : ''}.`,
        );
      }
    }

    // Totals in integer minor units. Tax is a documented placeholder (0);
    // shipping is the store's flat fee.
    const subtotalCents = checkoutLines.reduce((s, cl) => s + cl.unitPriceCents * cl.quantity, 0);
    const shippingCents = store.shippingFlatCents;
    const taxCents = 0;
    const totalCents = subtotalCents + shippingCents + taxCents;

    // Per-store atomic order sequence → human-friendly order number.
    const seqRows = await tx.$queryRaw<{ order_sequence: number }[]>`
      UPDATE "artist_stores" SET "order_sequence" = "order_sequence" + 1
      WHERE "id" = ${store.id}::uuid RETURNING "order_sequence"`;
    const seq = seqRows[0]!.order_sequence;
    const orderNumber = `WS-${store.id.slice(0, 8).toUpperCase()}-${String(seq).padStart(6, '0')}`;

    const addr = input.shippingAddress;
    const order = await tx.commerceOrder.create({
      data: {
        orderNumber,
        userId: user.id,
        storeId: store.id,
        status: 'PENDING_PAYMENT',
        currency: currency!,
        subtotalCents,
        shippingCents,
        taxCents,
        totalCents,
        idempotencyKey: input.idempotencyKey,
        shippingName: addr.name.trim(),
        shippingLine1: addr.line1.trim(),
        shippingLine2: addr.line2?.trim() || null,
        shippingCity: addr.city.trim(),
        shippingRegion: addr.region?.trim() || null,
        shippingPostal: addr.postal.trim(),
        shippingCountry: addr.country.trim().toUpperCase(),
        shippingPhone: addr.phone?.trim() || null,
        items: {
          create: checkoutLines.map((cl) => ({
            productId: cl.productId,
            variantId: cl.variantId,
            productTitle: cl.productTitle,
            variantName: cl.variantName,
            sku: cl.sku,
            quantity: cl.quantity,
            unitPriceCents: cl.unitPriceCents,
            currency: cl.currency,
          })),
        },
      },
      include: orderInclude,
    });

    // Provider-neutral payment intent. The payment row stores only
    // provider-safe references — never card data.
    const intent = await provider.createPaymentIntent({
      orderId: order.id,
      orderNumber,
      amountCents: totalCents,
      currency: currency!,
      idempotencyKey: `pay_${order.id}_${randomUUID().slice(0, 8)}`,
      customerRef: user.id,
    });
    await tx.commercePayment.create({
      data: {
        orderId: order.id,
        provider: provider.id,
        providerPaymentId: intent.providerPaymentId,
        status: 'INITIATED',
        amountCents: totalCents,
        currency: currency!,
        idempotencyKey: `pay_${order.id}`,
      },
    });

    // Clear the purchased lines.
    await tx.cartItem.deleteMany({ where: { cartId: cart!.id } });

    await recordAuditEvent(
      {
        actor: user,
        action: 'commerce.order.created',
        targetType: 'commerce_order',
        targetId: order.id,
        metadata: {
          orderNumber,
          storeId: store.id,
          totalCents,
          currency: currency!,
          itemCount: checkoutLines.length,
        },
      },
      tx,
    );

    const full = (await tx.commerceOrder.findUniqueOrThrow({
      where: { id: order.id },
      include: orderInclude,
    })) as unknown as OrderRow;
    return {
      order: toOrderDto(full, { includeAddress: true, includeBuyerName: false }),
      created: true,
      clientData: intent.clientData,
    };
  });
}

// ------------------------------------------------------ payment confirm ---

/**
 * Client-triggered payment completion. The client reports "the buyer
 * finished in the provider UI"; the server then VERIFIES with the provider
 * and only verified state moves the order. A forged callback can never
 * grant PAID.
 */
export async function confirmPayment(
  user: AuthUser,
  orderId: string,
  provider: CommercePaymentProvider,
): Promise<OrderDto> {
  const order = await prisma.commerceOrder.findUnique({
    where: { id: orderId },
    include: { payments: true },
  });
  if (!order || order.userId !== user.id) throw notFound('Order not found.');
  if (order.status !== 'PENDING_PAYMENT') {
    // Idempotent: a retried confirm on a settled order returns its current
    // state instead of an error.
    const full = (await prisma.commerceOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: orderInclude,
    })) as unknown as OrderRow;
    return toOrderDto(full, { includeAddress: true, includeBuyerName: false });
  }
  const payment = order.payments[0];
  if (!payment) throw conflict('No payment attempt exists for this order.');
  if (payment.provider !== provider.id) {
    throw conflict('Payment provider mismatch.');
  }
  const verified = await provider.verifyPayment(payment.providerPaymentId);
  if (verified.amountCents !== payment.amountCents || verified.currency !== payment.currency) {
    throw unprocessableEntity('Verified payment amount does not match the order.');
  }
  await applyVerifiedPayment(payment.id, { verified, actorId: user.id });
  const full = (await prisma.commerceOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: orderInclude,
  })) as unknown as OrderRow;
  return toOrderDto(full, { includeAddress: true, includeBuyerName: false });
}

/**
 * Mint a fresh provider intent after a failed/canceled attempt. The old
 * intent is superseded (verifyPayment on it is ignored by provider id
 * match), the payment row is reset, and history stays in the event log.
 */
export async function retryPayment(
  user: AuthUser,
  orderId: string,
  provider: CommercePaymentProvider,
): Promise<{ order: OrderDto; clientData: Record<string, unknown> }> {
  const order = await prisma.commerceOrder.findUnique({
    where: { id: orderId },
    include: { payments: true },
  });
  if (!order || order.userId !== user.id) throw notFound('Order not found.');
  if (order.status !== 'PENDING_PAYMENT') {
    throw conflict(`Order is ${order.status}; only PENDING_PAYMENT orders can be retried.`);
  }
  const payment = order.payments[0];
  if (!payment) throw conflict('No payment attempt exists for this order.');
  if (payment.status !== 'FAILED' && payment.status !== 'CANCELED') {
    throw conflict(`Payment is ${payment.status}; only failed payments can be retried.`);
  }
  const intent = await provider.createPaymentIntent({
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountCents: order.totalCents,
    currency: order.currency,
    idempotencyKey: `pay_${order.id}_${randomUUID().slice(0, 8)}`,
    customerRef: user.id,
  });
  await prisma.commercePayment.update({
    where: { id: payment.id },
    data: {
      providerPaymentId: intent.providerPaymentId,
      status: 'INITIATED',
      idempotencyKey: `pay_${order.id}_${randomUUID().slice(0, 8)}`,
    },
  });
  // Re-reserve inventory for the new attempt (the failure path released it).
  await prisma.$transaction(async (tx) => {
    const items = await tx.commerceOrderItem.findMany({
      where: { orderId: order.id },
      select: { productId: true, variantId: true, quantity: true, productTitle: true, variantName: true },
    });
    for (const item of items) {
      const ok = await reserveInventory(tx, item.productId, item.variantId, item.quantity);
      if (!ok) {
        throw conflict(
          `Insufficient stock for "${item.productTitle}"${item.variantName ? ` (${item.variantName})` : ''}.`,
        );
      }
    }
  });
  const full = (await prisma.commerceOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: orderInclude,
  })) as unknown as OrderRow;
  return {
    order: toOrderDto(full, { includeAddress: true, includeBuyerName: false }),
    clientData: intent.clientData,
  };
}

// ---------------------------------------------------------------- cancel ---

/** Buyer cancellation. Only PENDING_PAYMENT orders; reservations released. */
export async function cancelOrder(user: AuthUser, orderId: string): Promise<OrderDto> {
  const order = await prisma.commerceOrder.findUnique({ where: { id: orderId } });
  if (!order || order.userId !== user.id) throw notFound('Order not found.');
  if (order.status !== 'PENDING_PAYMENT') {
    throw conflict(`Order is ${order.status}; only unpaid orders can be canceled.`);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.commerceOrder.update({
      where: { id: orderId },
      data: { status: 'CANCELED' },
    });
    await moveInventory(tx, orderId, 'release');
    await recordAuditEvent(
      {
        actor: user,
        action: 'commerce.order.canceled',
        targetType: 'commerce_order',
        targetId: orderId,
        metadata: { orderNumber: order.orderNumber },
      },
      tx,
    );
    return row;
  });
  void updated;
  const full = (await prisma.commerceOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: orderInclude,
  })) as unknown as OrderRow;
  return toOrderDto(full, { includeAddress: true, includeBuyerName: false });
}

// ------------------------------------------------------------ fulfillment ---

const FULFILLMENT_TRANSITIONS: Record<string, readonly string[]> = {
  PAID: ['PROCESSING'],
  PROCESSING: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  PENDING_PAYMENT: [],
  CANCELED: [],
  REFUNDED: [],
};

/**
 * Manual fulfillment transitions (no carrier integration in Phase 30).
 * Artist owner or ADMIN. Payment state is untouched — a shipped order is
 * still paid, and payment knows nothing about shipping.
 */
export async function updateFulfillment(
  user: AuthUser,
  orderId: string,
  status: 'PROCESSING' | 'SHIPPED' | 'DELIVERED',
): Promise<OrderDto> {
  const order = await prisma.commerceOrder.findUnique({
    where: { id: orderId },
    include: { store: { include: { artist: { select: { ownerUserId: true } } } } },
  });
  if (!order) throw notFound('Order not found.');
  if (!(await canOperateStore(user, order.store))) {
    throw forbidden('You do not manage this store.');
  }
  if (!FULFILLMENT_TRANSITIONS[order.status].includes(status)) {
    throw unprocessableEntity(`Cannot transition order from ${order.status} to ${status}.`);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.commerceOrder.update({ where: { id: orderId }, data: { status } });
    await recordAuditEvent(
      {
        actor: user,
        action: 'commerce.order.fulfillment_changed',
        targetType: 'commerce_order',
        targetId: orderId,
        metadata: { orderNumber: order.orderNumber, oldStatus: order.status, newStatus: status },
      },
      tx,
    );
    return row;
  });
  void updated;
  const full = (await prisma.commerceOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: orderInclude,
  })) as unknown as OrderRow;
  return toOrderDto(full, { includeAddress: true, includeBuyerName: true });
}

// --------------------------------------------------------------- refunds ---

export interface RefundDto {
  id: string;
  orderId: string;
  amountCents: number;
  currency: string;
  reason: string | null;
  status: string;
  providerRefundId: string | null;
  createdAt: Date;
}

/**
 * Full refunds through the provider abstraction. Only the store owner or
 * ADMIN may refund; the buyer cannot refund themselves. Unpaid orders can
 * never be "refunded" (cancel them instead). Phase 30 supports full
 * refunds only — corrections use explicit refund records, never mutated
 * history.
 */
export async function refundOrder(
  user: AuthUser,
  orderId: string,
  reason: string | undefined,
  idempotencyKey: string,
  provider: CommercePaymentProvider,
): Promise<RefundDto> {
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw badRequest('idempotencyKey is required (max 128 chars).');
  }
  const order = await prisma.commerceOrder.findUnique({
    where: { id: orderId },
    include: {
      store: { include: { artist: { select: { ownerUserId: true } } } },
      payments: true,
    },
  });
  if (!order) throw notFound('Order not found.');
  if (!(await canOperateStore(user, order.store))) {
    throw forbidden('Only the store owner or a commerce administrator can issue refunds.');
  }

  // Idempotency first: the same key returns the original refund even when the
  // order has since moved to REFUNDED.
  const dupe = await prisma.commerceRefund.findUnique({ where: { idempotencyKey } });
  if (dupe) {
    return {
      id: dupe.id,
      orderId: dupe.orderId,
      amountCents: dupe.amountCents,
      currency: dupe.currency,
      reason: dupe.reason,
      status: dupe.status,
      providerRefundId: dupe.providerRefundId,
      createdAt: dupe.createdAt,
    };
  }

  // An unpaid order is never "refunded" — it is canceled.
  if (order.status === 'PENDING_PAYMENT' || order.status === 'CANCELED') {
    throw unprocessableEntity(`Order is ${order.status}; only paid orders can be refunded.`);
  }
  if (order.status === 'REFUNDED') {
    throw conflict('Order is already refunded.');
  }
  const payment = order.payments[0];
  if (!payment || payment.status !== 'SUCCEEDED') {
    throw unprocessableEntity('Only orders with a succeeded payment can be refunded.');
  }

  const result = await provider.refundPayment(
    payment.providerPaymentId,
    order.totalCents,
    order.currency,
    idempotencyKey,
  );

  const refund = await prisma.$transaction(async (tx) => {
    const row = await tx.commerceRefund.create({
      data: {
        paymentId: payment.id,
        orderId: order.id,
        amountCents: order.totalCents,
        currency: order.currency,
        reason: reason?.slice(0, 500) ?? null,
        status: result.status,
        providerRefundId: result.providerRefundId,
        idempotencyKey,
        createdBy: user.id,
      },
    });
    if (result.status === 'SUCCEEDED') {
      await tx.commercePayment.update({ where: { id: payment.id }, data: { status: 'REFUNDED' } });
      await tx.commerceOrder.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      // Restock: refunded units return to the sellable pool. Documented
      // simplification — without carrier integration the platform cannot
      // know whether goods were returned.
      const items = await tx.commerceOrderItem.findMany({
        where: { orderId: order.id },
        select: { productId: true, variantId: true, quantity: true },
      });
      for (const item of items) {
        const where = item.variantId
          ? { productId: item.productId, variantId: item.variantId }
          : { productId: item.productId, variantId: null };
        const inv = await tx.inventoryItem.findFirst({ where });
        if (inv) {
          await tx.inventoryItem.update({
            where: { id: inv.id },
            data: {
              quantitySold: { decrement: item.quantity },
              quantityAvailable: { increment: item.quantity },
            },
          });
        }
      }
    }
    await recordAuditEvent(
      {
        actor: user,
        action: 'commerce.order.refunded',
        targetType: 'commerce_order',
        targetId: order.id,
        metadata: {
          orderNumber: order.orderNumber,
          amountCents: order.totalCents,
          currency: order.currency,
          providerRefundId: result.providerRefundId,
        },
      },
      tx,
    );
    return row;
  });

  return {
    id: refund.id,
    orderId: refund.orderId,
    amountCents: refund.amountCents,
    currency: refund.currency,
    reason: refund.reason,
    status: refund.status,
    providerRefundId: refund.providerRefundId,
    createdAt: refund.createdAt,
  };
}

// ----------------------------------------------------------------- views ---

export interface ListOrdersQuery extends PaginationQuery {
  status?: OrderStatus;
}

/** Buyer's own order history. Address included — it is their own PII. */
export async function listMyOrders(
  user: AuthUser,
  query: ListOrdersQuery,
): Promise<PageEnvelope<OrderDto>> {
  const p = parsePagination(query);
  const where: Prisma.CommerceOrderWhereInput = { userId: user.id };
  if (query.status) where.status = query.status;
  const [total, rows] = await prisma.$transaction([
    prisma.commerceOrder.count({ where }),
    prisma.commerceOrder.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (p.page - 1) * p.limit,
      take: p.limit,
    }),
  ]);
  return pageEnvelope(
    (rows as unknown as OrderRow[]).map((r) =>
      toOrderDto(r, { includeAddress: true, includeBuyerName: false }),
    ),
    total,
    p,
  );
}

/** Store owner's order list. Includes buyer name + shipping address (fulfillment need). */
export async function listStoreOrders(
  user: AuthUser,
  storeId: string,
  query: ListOrdersQuery,
): Promise<PageEnvelope<OrderDto>> {
  const store = await prisma.artistStore.findUnique({
    where: { id: storeId },
    include: { artist: { select: { ownerUserId: true } } },
  });
  if (!store) throw notFound('Store not found.');
  if (!canManageStore(user, store)) throw forbidden('You do not manage this store.');
  const p = parsePagination(query);
  const where: Prisma.CommerceOrderWhereInput = { storeId };
  if (query.status) where.status = query.status;
  const [total, rows] = await prisma.$transaction([
    prisma.commerceOrder.count({ where }),
    prisma.commerceOrder.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (p.page - 1) * p.limit,
      take: p.limit,
    }),
  ]);
  return pageEnvelope(
    (rows as unknown as OrderRow[]).map((r) =>
      toOrderDto(r, { includeAddress: true, includeBuyerName: true }),
    ),
    total,
    p,
  );
}

/** ADMIN-only platform order list. */
export async function listOrdersAdmin(query: ListOrdersQuery): Promise<PageEnvelope<OrderDto>> {
  const p = parsePagination(query);
  const where: Prisma.CommerceOrderWhereInput = {};
  if (query.status) where.status = query.status;
  const [total, rows] = await prisma.$transaction([
    prisma.commerceOrder.count({ where }),
    prisma.commerceOrder.findMany({
      where,
      include: orderInclude,
      orderBy: { createdAt: 'desc' },
      skip: (p.page - 1) * p.limit,
      take: p.limit,
    }),
  ]);
  return pageEnvelope(
    (rows as unknown as OrderRow[]).map((r) =>
      toOrderDto(r, { includeAddress: true, includeBuyerName: true }),
    ),
    total,
    p,
  );
}

/**
 * Order detail with role-appropriate visibility:
 * - buyer: own orders (address included)
 * - store owner / ADMIN: store's orders (address + buyer name)
 * - anyone else: 404 (no existence leak across users)
 */
export async function getOrder(user: AuthUser, orderId: string): Promise<OrderDto> {
  const order = (await prisma.commerceOrder.findUnique({
    where: { id: orderId },
    include: {
      ...orderInclude,
      store: {
        select: { id: true, name: true, artist: { select: { ownerUserId: true } } },
      },
    },
  })) as unknown as (OrderRow & { store: { artist: { ownerUserId: string | null } }; userId: string }) | null;
  if (!order) throw notFound('Order not found.');
  const isBuyer = order.userId === user.id;
  const isStoreManager = canManageStore(user, order.store);
  if (!isBuyer && !isStoreManager && !isAdmin(user)) throw notFound('Order not found.');
  return toOrderDto(order, {
    includeAddress: true,
    includeBuyerName: isStoreManager || isAdmin(user),
  });
}

