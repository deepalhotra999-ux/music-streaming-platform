// Phase 30 — shopping cart.
//
// The cart belongs to the authenticated user (server-derived identity;
// arbitrary userIds are never accepted). Cart lines carry NO prices —
// prices are always re-read server-side at checkout, so a client can never
// smuggle a price into an order. Availability is soft-checked on mutation
// and hard-checked (with atomic reservation) at checkout.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, notFound, unprocessableEntity } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import type { Config } from '../../config.js';

type Db = PrismaClient | Prisma.TransactionClient;

export interface CartLineDto {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  product: {
    id: string;
    title: string;
    status: string;
    priceCents: number;
    currency: string;
    imageUrl: string | null;
    storeId: string;
    storeName: string;
    storeStatus: string;
  };
  variant: {
    id: string;
    name: string;
    priceCents: number;
  } | null;
  /** Current sellable units for this purchasable (display + validation). */
  availableQuantity: number;
  purchasable: boolean;
}

export interface CartDto {
  items: CartLineDto[];
  /** Lines grouped by store so the client can run one checkout per store. */
  storeGroups: { storeId: string; storeName: string; items: CartLineDto[] }[];
}

type CartLineRow = {
  id: string;
  quantity: number;
  productId: string;
  variantId: string | null;
  product: {
    id: string;
    title: string;
    status: string;
    priceCents: number;
    currency: string;
    imageUrl: string | null;
    storeId: string;
    store: { id: string; name: string; status: string };
    inventory: { variantId: string | null; quantityAvailable: number; quantityReserved: number }[];
  };
  variant: { id: string; name: string; priceCents: number; productId: string } | null;
};

const lineInclude = {
  product: {
    include: {
      store: { select: { id: true, name: true, status: true } },
      inventory: { select: { variantId: true, quantityAvailable: true, quantityReserved: true } },
    },
  },
  variant: { select: { id: true, name: true, priceCents: true, productId: true } },
} as const;

// Free (purchasable) stock = on-hand minus units reserved for unpaid orders.
function availableFor(row: CartLineRow): number {
  const inv = row.product.inventory.find((i) => i.variantId === row.variantId);
  if (!inv) return 0;
  return Math.max(0, inv.quantityAvailable - inv.quantityReserved);
}

function toLineDto(row: CartLineRow): CartLineDto {
  const purchasable = row.product.status === 'ACTIVE' && row.product.store.status === 'ACTIVE';
  return {
    id: row.id,
    productId: row.productId,
    variantId: row.variantId,
    quantity: row.quantity,
    product: {
      id: row.product.id,
      title: row.product.title,
      status: row.product.status,
      priceCents: row.product.priceCents,
      currency: row.product.currency,
      imageUrl: row.product.imageUrl,
      storeId: row.product.store.id,
      storeName: row.product.store.name,
      storeStatus: row.product.store.status,
    },
    variant: row.variant
      ? { id: row.variant.id, name: row.variant.name, priceCents: row.variant.priceCents }
      : null,
    availableQuantity: availableFor(row),
    purchasable,
  };
}

function toCartDto(rows: CartLineRow[]): CartDto {
  const items = rows.map(toLineDto);
  const groups = new Map<string, { storeId: string; storeName: string; items: CartLineDto[] }>();
  for (const item of items) {
    let g = groups.get(item.product.storeId);
    if (!g) {
      g = { storeId: item.product.storeId, storeName: item.product.storeName, items: [] };
      groups.set(item.product.storeId, g);
    }
    g.items.push(item);
  }
  return { items, storeGroups: [...groups.values()] };
}

async function getOrCreateCart(userId: string, db: Db): Promise<{ id: string }> {
  const existing = await db.cart.findUnique({ where: { userId }, select: { id: true } });
  if (existing) return existing;
  try {
    return await db.cart.create({ data: { userId }, select: { id: true } });
  } catch {
    // Lost a race with another request — the unique(userId) row now exists.
    const retry = await db.cart.findUniqueOrThrow({ where: { userId }, select: { id: true } });
    return retry;
  }
}

async function loadCartLines(cartId: string, db: Db): Promise<CartLineRow[]> {
  return db.cartItem.findMany({
    where: { cartId },
    include: lineInclude,
    orderBy: { createdAt: 'asc' },
  }) as unknown as Promise<CartLineRow[]>;
}

export async function getCart(user: AuthUser): Promise<CartDto> {
  const cart = await getOrCreateCart(user.id, prisma);
  return toCartDto(await loadCartLines(cart.id, prisma));
}

export interface AddToCartInput {
  productId: string;
  variantId?: string;
  quantity: number;
}

export async function addToCart(
  user: AuthUser,
  input: AddToCartInput,
  config: Config,
): Promise<CartDto> {
  const maxQty = config.commerce.maxCartLineQuantity;
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > maxQty) {
    throw badRequest(`Quantity must be between 1 and ${maxQty}.`);
  }
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      include: {
        store: { select: { status: true } },
        inventory: { select: { variantId: true, quantityAvailable: true, quantityReserved: true } },
      },
    });
    if (!product) throw notFound('Product not found.');
    // Only ACTIVE products on ACTIVE stores can enter the cart. Archived /
    // removed / paused / sold-out products are rejected here AND at
    // checkout (defense in depth).
    if (product.status !== 'ACTIVE') {
      throw unprocessableEntity('This product is not currently available.');
    }
    if (product.store.status !== 'ACTIVE') {
      throw unprocessableEntity('This store is not currently available.');
    }
    if (input.variantId) {
      const variant = await tx.productVariant.findUnique({
        where: { id: input.variantId },
        select: { productId: true },
      });
      if (!variant || variant.productId !== product.id) {
        throw notFound('Variant not found.');
      }
    } else {
      const hasVariants = await tx.productVariant.count({ where: { productId: product.id } });
      if (hasVariants > 0) throw unprocessableEntity('This product requires a variant selection.');
    }
    const inv = product.inventory.find((i) => i.variantId === (input.variantId ?? null));
    const available = inv ? Math.max(0, inv.quantityAvailable - inv.quantityReserved) : 0;
    if (input.quantity > available) {
      throw unprocessableEntity(`Only ${available} unit(s) available.`);
    }

    const cart = await getOrCreateCart(user.id, tx);
    const where = input.variantId
      ? { cartId: cart.id, variantId: input.variantId }
      : { cartId: cart.id, productId: product.id, variantId: null };
    const existing = await tx.cartItem.findFirst({ where });
    if (existing) {
      const next = existing.quantity + input.quantity;
      if (next > maxQty) throw badRequest(`Quantity must be between 1 and ${maxQty}.`);
      if (next > available) throw unprocessableEntity(`Only ${available} unit(s) available.`);
      await tx.cartItem.update({ where: { id: existing.id }, data: { quantity: next } });
    } else {
      await tx.cartItem.create({
        data: {
          cartId: cart.id,
          productId: product.id,
          variantId: input.variantId ?? null,
          quantity: input.quantity,
        },
      });
    }
    return toCartDto(await loadCartLines(cart.id, tx));
  });
}

export async function updateCartItem(
  user: AuthUser,
  itemId: string,
  quantity: number,
  config: Config,
): Promise<CartDto> {
  const maxQty = config.commerce.maxCartLineQuantity;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > maxQty) {
    throw badRequest(`Quantity must be between 0 and ${maxQty}.`);
  }
  return prisma.$transaction(async (tx) => {
    const item = await tx.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: { select: { userId: true } } },
    });
    // A user can never see or touch another user's cart: the line must
    // belong to the caller's cart or it does not exist for them.
    if (!item || item.cart.userId !== user.id) throw notFound('Cart item not found.');
    if (quantity === 0) {
      await tx.cartItem.delete({ where: { id: itemId } });
    } else {
      await tx.cartItem.update({ where: { id: itemId }, data: { quantity } });
    }
    const cart = await getOrCreateCart(user.id, tx);
    return toCartDto(await loadCartLines(cart.id, tx));
  });
}

export async function removeCartItem(user: AuthUser, itemId: string): Promise<CartDto> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: { select: { userId: true } } },
    });
    if (!item || item.cart.userId !== user.id) throw notFound('Cart item not found.');
    await tx.cartItem.delete({ where: { id: itemId } });
    const cart = await getOrCreateCart(user.id, tx);
    return toCartDto(await loadCartLines(cart.id, tx));
  });
}

export async function clearCart(user: AuthUser): Promise<void> {
  const cart = await prisma.cart.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (cart) await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
}
