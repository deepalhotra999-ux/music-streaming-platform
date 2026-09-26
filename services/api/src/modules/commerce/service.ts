// Phase 30 — artist commerce: stores, products, variants, inventory.
//
// Boundaries (do not relax without a new ADR):
// - Commerce money NEVER touches royalty tables, subscription tables, or
//   playback events. Separate tables, separate code paths, separate audit
//   actions. Commerce revenue is not part of the royalty pool.
// - All money is integer minor units. Currency is explicit on every
//   monetary record. No floating point, no silent currency conversion.
// - Artist ownership is always derived server-side: the caller is
//   authenticated, the artist row's ownerUserId is the authority. Client
//   supplied artistIds are never trusted for ownership.
// - Only verified artists (Artist.verified, the existing Phase 4/16
//   concept) may create a storefront. LISTENER/ADMIN cannot create stores.
// - Only ACTIVE products on ACTIVE stores are purchasable. ARCHIVED and
//   REMOVED products are never purchasable; historical order snapshots are
//   immutable and survive archival/removal.
// - Inventory reservation is atomic (single UPDATE with an availability
//   guard) — two buyers racing for the last unit cannot both win.
// - Shipping addresses are PII: never in public DTOs, never in audit
//   metadata, never in logs.

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessableEntity } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import { canManageArtist, hasPermissions, isAdmin } from '../../http/authorization.js';
import { recordAuditEvent } from '../audit/service.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';
import type { Config } from '../../config.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type StoreStatus = 'ACTIVE' | 'PAUSED' | 'SUSPENDED';
export type ProductType = 'APPAREL' | 'ACCESSORY' | 'MUSIC' | 'ART' | 'OTHER';
export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'SOLD_OUT' | 'ARCHIVED' | 'REMOVED';

export const PRODUCT_TYPES: readonly ProductType[] = ['APPAREL', 'ACCESSORY', 'MUSIC', 'ART', 'OTHER'];
export const PRODUCT_STATUSES: readonly ProductStatus[] = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'SOLD_OUT',
  'ARCHIVED',
  'REMOVED',
];

export interface CommerceLimits {
  storeNameMaxLength: number;
  storeDescriptionMaxLength: number;
  productTitleMaxLength: number;
  productDescriptionMaxLength: number;
  maxVariantsPerProduct: number;
}

export function commerceLimits(config: Config): CommerceLimits {
  return {
    storeNameMaxLength: config.commerce.storeNameMaxLength,
    storeDescriptionMaxLength: config.commerce.storeDescriptionMaxLength,
    productTitleMaxLength: config.commerce.productTitleMaxLength,
    productDescriptionMaxLength: config.commerce.productDescriptionMaxLength,
    maxVariantsPerProduct: config.commerce.maxVariantsPerProduct,
  };
}

// ---------------------------------------------------------------- DTOs ---

export interface StoreArtistRef {
  id: string;
  name: string;
  verified: boolean;
}

export interface StoreDto {
  id: string;
  artist: StoreArtistRef;
  name: string;
  description: string | null;
  status: StoreStatus;
  imageUrl: string | null;
  bannerUrl: string | null;
  contactEmail: string | null;
  contactUrl: string | null;
  currency: string;
  shippingFlatCents: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VariantDto {
  id: string;
  name: string;
  sku: string | null;
  priceCents: number;
  currency: string;
  /** Public availability; owner views add reserved/sold via inventory. */
  availableQuantity: number;
}

export interface InventoryDto {
  productId: string;
  variantId: string | null;
  quantityAvailable: number;
  quantityReserved: number;
  quantitySold: number;
}

export interface ProductImageDto {
  id: string;
  imageUrl: string;
  altText: string | null;
  sortOrder: number;
}

export interface ProductDto {
  id: string;
  storeId: string;
  artistId: string;
  title: string;
  description: string | null;
  type: ProductType;
  status: ProductStatus;
  priceCents: number;
  currency: string;
  sku: string | null;
  imageUrl: string | null;
  images: ProductImageDto[];
  variants: VariantDto[];
  trackRef: { id: string; title: string } | null;
  albumRef: { id: string; title: string } | null;
  /** Owner-only full inventory; public sees availability inside variants. */
  inventory: InventoryDto[] | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------- eligibility ---

interface OwnedArtist {
  id: string;
  name: string;
  verified: boolean;
  ownerUserId: string | null;
}

/** Load an artist the caller may manage, or throw 403/404. */
async function requireManagedArtist(
  user: AuthUser,
  artistId: string,
  db: Db = prisma,
): Promise<OwnedArtist> {
  const artist = await db.artist.findUnique({
    where: { id: artistId },
    select: { id: true, name: true, verified: true, ownerUserId: true, deletedAt: true },
  });
  if (!artist || artist.deletedAt) throw notFound('Artist not found.');
  if (!canManageArtist(user, artist)) {
    throw forbidden('You do not manage this artist.');
  }
  return artist;
}

/**
 * Storefront eligibility: the caller must hold the ARTIST role (ADMIN
 * retains moderation authority but does not create stores) and own a
 * VERIFIED artist. The verified flag is the existing Phase 4/16 artist
 * verification concept — unverified artists cannot sell.
 */
async function requireStoreEligibleArtist(
  user: AuthUser,
  artistId: string,
  db: Db = prisma,
): Promise<OwnedArtist> {
  if (user.role !== 'ARTIST' && !isAdmin(user)) {
    throw forbidden('Only artist accounts can manage storefronts.');
  }
  const artist = await requireManagedArtist(user, artistId, db);
  if (!artist.verified && !isAdmin(user)) {
    throw forbidden('The artist must be verified before opening a storefront.');
  }
  return artist;
}

/** True when the caller owns the store (via the artist) or is ADMIN. */
export function canManageStore(
  user: AuthUser,
  store: { artist: { ownerUserId: string | null } },
): boolean {
  return canManageArtist(user, store.artist);
}

/**
 * Admin V2 — true when the caller may operate on any store's orders: the
 * store owner, a legacy admin, or any admin holding 'commerce.manage' (e.g.
 * SUPPORT_ADMIN handling refunds/fulfillment). Ownership and legacy behavior
 * are unchanged; the permission path is additive.
 */
export async function canOperateStore(
  user: AuthUser,
  store: { artist: { ownerUserId: string | null } },
): Promise<boolean> {
  if (canManageStore(user, store)) return true;
  return hasPermissions(user.id, user.role, 'commerce.manage');
}

async function requireManagedStore(
  user: AuthUser,
  storeId: string,
  db: Db = prisma,
): Promise<{ id: string; artistId: string; currency: string; status: StoreStatus }> {
  const store = await db.artistStore.findUnique({
    where: { id: storeId },
    include: { artist: { select: { ownerUserId: true } } },
  });
  if (!store) throw notFound('Store not found.');
  if (!canManageStore(user, store)) throw forbidden('You do not manage this store.');
  return { id: store.id, artistId: store.artistId, currency: store.currency, status: store.status };
}

// ---------------------------------------------------------------- DTOs ---

function toStoreDto(row: {
  id: string;
  name: string;
  description: string | null;
  status: StoreStatus;
  imageUrl: string | null;
  bannerUrl: string | null;
  contactEmail: string | null;
  contactUrl: string | null;
  currency: string;
  shippingFlatCents: number;
  createdAt: Date;
  updatedAt: Date;
  artist: StoreArtistRef;
}): StoreDto {
  return { ...row };
}

type ProductRow = {
  id: string;
  storeId: string;
  artistId: string;
  title: string;
  description: string | null;
  type: ProductType;
  status: ProductStatus;
  priceCents: number;
  currency: string;
  sku: string | null;
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
  images: { id: string; imageUrl: string; altText: string | null; sortOrder: number }[];
  variants: {
    id: string;
    name: string;
    sku: string | null;
    priceCents: number;
    currency: string;
    inventory: { quantityAvailable: number; quantityReserved: number; quantitySold: number }[];
  }[];
  inventory: {
    productId: string;
    variantId: string | null;
    quantityAvailable: number;
    quantityReserved: number;
    quantitySold: number;
  }[];
  track: { id: string; title: string } | null;
  album: { id: string; title: string } | null;
};

function toProductDto(row: ProductRow, includeInventory: boolean): ProductDto {
  const inventoryByVariant = new Map<string | null, InventoryDto>();
  for (const inv of row.inventory) {
    inventoryByVariant.set(inv.variantId, {
      productId: inv.productId,
      variantId: inv.variantId,
      quantityAvailable: inv.quantityAvailable,
      quantityReserved: inv.quantityReserved,
      quantitySold: inv.quantitySold,
    });
  }
  return {
    id: row.id,
    storeId: row.storeId,
    artistId: row.artistId,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    priceCents: row.priceCents,
    currency: row.currency,
    sku: row.sku,
    imageUrl: row.imageUrl,
    images: row.images.map((i) => ({
      id: i.id,
      imageUrl: i.imageUrl,
      altText: i.altText,
      sortOrder: i.sortOrder,
    })),
    variants: row.variants.map((v) => ({
      id: v.id,
      name: v.name,
      sku: v.sku,
      priceCents: v.priceCents,
      currency: v.currency,
      availableQuantity: Math.max(
        0,
        (v.inventory[0]?.quantityAvailable ?? 0) - (v.inventory[0]?.quantityReserved ?? 0),
      ),
    })),
    trackRef: row.track ? { id: row.track.id, title: row.track.title } : null,
    albumRef: row.album ? { id: row.album.id, title: row.album.title } : null,
    inventory: includeInventory ? [...inventoryByVariant.values()] : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const productInclude = {
  images: { orderBy: { sortOrder: 'asc' as const } },
  variants: {
    orderBy: { sortOrder: 'asc' as const },
    include: { inventory: true },
  },
  inventory: true,
  track: { select: { id: true, title: true } },
  album: { select: { id: true, title: true } },
} as const;

// ---------------------------------------------------------------- stores ---

export interface CreateStoreInput {
  artistId: string;
  name: string;
  description?: string;
  currency?: string;
  imageUrl?: string;
  bannerUrl?: string;
  contactEmail?: string;
  contactUrl?: string;
  shippingFlatCents?: number;
}

const ISO_CURRENCY = /^[A-Z]{3}$/;

export async function createStore(
  user: AuthUser,
  input: CreateStoreInput,
  limits: CommerceLimits,
): Promise<StoreDto> {
  const artist = await requireStoreEligibleArtist(user, input.artistId);
  const name = input.name.trim();
  if (!name || name.length > limits.storeNameMaxLength) {
    throw badRequest(`Store name must be 1–${limits.storeNameMaxLength} characters.`);
  }
  if (input.description && input.description.length > limits.storeDescriptionMaxLength) {
    throw badRequest(`Store description is too long (max ${limits.storeDescriptionMaxLength}).`);
  }
  const currency = (input.currency ?? 'USD').toUpperCase();
  if (!ISO_CURRENCY.test(currency)) throw badRequest('Currency must be a 3-letter ISO 4217 code.');
  const shippingFlatCents = input.shippingFlatCents ?? 0;
  if (!Number.isSafeInteger(shippingFlatCents) || shippingFlatCents < 0) {
    throw badRequest('shippingFlatCents must be a non-negative integer.');
  }
  let store;
  try {
    store = await prisma.artistStore.create({
      data: {
        artistId: artist.id,
        name,
        description: input.description?.trim() || null,
        currency,
        imageUrl: input.imageUrl ?? null,
        bannerUrl: input.bannerUrl ?? null,
        contactEmail: input.contactEmail ?? null,
        contactUrl: input.contactUrl ?? null,
        shippingFlatCents,
      },
      include: { artist: { select: { id: true, name: true, verified: true } } },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw conflict('This artist already has a storefront.');
    }
    throw e;
  }
  await recordAuditEvent({
    actor: user,
    action: 'commerce.store.created',
    targetType: 'artist_store',
    targetId: store.id,
    metadata: { artistId: artist.id, currency },
  });
  return toStoreDto(store);
}

export interface UpdateStoreInput {
  name?: string;
  description?: string | null;
  status?: StoreStatus;
  imageUrl?: string | null;
  bannerUrl?: string | null;
  contactEmail?: string | null;
  contactUrl?: string | null;
  shippingFlatCents?: number;
}

const ARTIST_STORE_TRANSITIONS: Record<StoreStatus, readonly StoreStatus[]> = {
  ACTIVE: ['PAUSED', 'SUSPENDED'],
  PAUSED: ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'PAUSED'],
};

export async function updateStore(
  user: AuthUser,
  storeId: string,
  input: UpdateStoreInput,
  limits: CommerceLimits,
): Promise<StoreDto> {
  const managed = await requireManagedStore(user, storeId);
  const store = await prisma.artistStore.findUniqueOrThrow({ where: { id: storeId } });
  const data: Prisma.ArtistStoreUpdateInput = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > limits.storeNameMaxLength) {
      throw badRequest(`Store name must be 1–${limits.storeNameMaxLength} characters.`);
    }
    data.name = name;
  }
  if (input.description !== undefined) {
    if (input.description && input.description.length > limits.storeDescriptionMaxLength) {
      throw badRequest(`Store description is too long (max ${limits.storeDescriptionMaxLength}).`);
    }
    data.description = input.description?.trim() || null;
  }
  if (input.status !== undefined) {
    if (!ARTIST_STORE_TRANSITIONS[store.status].includes(input.status)) {
      throw unprocessableEntity(`Cannot transition store from ${store.status} to ${input.status}.`);
    }
    // SUSPENDED is a moderation state: only ADMIN may suspend or reinstate.
    if ((input.status === 'SUSPENDED' || store.status === 'SUSPENDED') && !isAdmin(user)) {
      throw forbidden('Only administrators can suspend or reinstate a store.');
    }
    data.status = input.status;
  }
  if (input.imageUrl !== undefined) data.imageUrl = input.imageUrl;
  if (input.bannerUrl !== undefined) data.bannerUrl = input.bannerUrl;
  if (input.contactEmail !== undefined) data.contactEmail = input.contactEmail;
  if (input.contactUrl !== undefined) data.contactUrl = input.contactUrl;
  if (input.shippingFlatCents !== undefined) {
    if (!Number.isSafeInteger(input.shippingFlatCents) || input.shippingFlatCents < 0) {
      throw badRequest('shippingFlatCents must be a non-negative integer.');
    }
    data.shippingFlatCents = input.shippingFlatCents;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.artistStore.update({
      where: { id: storeId },
      data,
      include: { artist: { select: { id: true, name: true, verified: true } } },
    });
    await recordAuditEvent(
      {
        actor: user,
        action:
          input.status !== undefined && input.status !== store.status
            ? 'commerce.store.status_changed'
            : 'commerce.store.updated',
        targetType: 'artist_store',
        targetId: storeId,
        metadata:
          input.status !== undefined && input.status !== store.status
            ? { oldStatus: store.status, newStatus: input.status }
            : { artistId: managed.artistId },
      },
      tx,
    );
    return row;
  });
  return toStoreDto(updated);
}

/** Public storefront read. Non-ACTIVE stores are visible to owner/ADMIN only. */
export async function getStore(storeId: string, viewer: AuthUser | null): Promise<StoreDto> {
  const store = await prisma.artistStore.findUnique({
    where: { id: storeId },
    include: { artist: { select: { id: true, name: true, verified: true, ownerUserId: true } } },
  });
  if (!store) throw notFound('Store not found.');
  if (store.status !== 'ACTIVE') {
    if (!viewer || !canManageStore(viewer, store)) throw notFound('Store not found.');
  }
  return toStoreDto(store);
}

/** Public storefront lookup by artist. Same visibility rules as getStore. */
export async function getStoreByArtist(
  artistId: string,
  viewer: AuthUser | null,
): Promise<StoreDto> {
  const store = await prisma.artistStore.findUnique({
    where: { artistId },
    include: { artist: { select: { id: true, name: true, verified: true, ownerUserId: true } } },
  });
  if (!store) throw notFound('Store not found.');
  if (store.status !== 'ACTIVE') {
    if (!viewer || !canManageStore(viewer, store)) throw notFound('Store not found.');
  }
  return toStoreDto(store);
}

export interface ListStoresQuery extends PaginationQuery {
  status?: StoreStatus;
  q?: string;
}

/** ADMIN-only store listing (all statuses). */
export async function listStoresAdmin(
  query: ListStoresQuery,
): Promise<PageEnvelope<StoreDto>> {
  const p = parsePagination(query);
  const where: Prisma.ArtistStoreWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.q) where.name = { contains: query.q, mode: 'insensitive' };
  const [total, rows] = await prisma.$transaction([
    prisma.artistStore.count({ where }),
    prisma.artistStore.findMany({
      where,
      include: { artist: { select: { id: true, name: true, verified: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (p.page - 1) * p.limit,
      take: p.limit,
    }),
  ]);
  return pageEnvelope(rows.map(toStoreDto), total, p);
}

export interface ListProductsAdminQuery extends PaginationQuery {
  status?: string;
  q?: string;
}

export async function listProductsAdmin(
  query: ListProductsAdminQuery,
): Promise<PageEnvelope<ProductDto>> {
  const p = parsePagination(query);
  const where: Prisma.ProductWhereInput = {};
  if (query.status) where.status = query.status as Prisma.ProductWhereInput['status'];
  if (query.q) where.title = { contains: query.q, mode: 'insensitive' };
  const [total, rows] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (p.page - 1) * p.limit,
      take: p.limit,
    }),
  ]);
  // Admin list uses the same public DTO shape (no inventory internals).
  const dtos: ProductDto[] = rows.map((r) => ({
    id: r.id,
    storeId: r.storeId,
    artistId: r.artistId,
    title: r.title,
    description: r.description,
    type: r.type,
    status: r.status,
    priceCents: r.priceCents,
    currency: r.currency,
    sku: r.sku,
    imageUrl: r.imageUrl,
    images: [],
    variants: [],
    trackRef: null,
    albumRef: null,
    inventory: null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return pageEnvelope(dtos, total, p);
}

export interface CommerceStats {
  storeCount: number;
  activeStoreCount: number;
  productCount: number;
  activeProductCount: number;
  orderCount: number;
  paidOrderCount: number;
  grossCentsByCurrency: Record<string, number>;
  refundedCentsByCurrency: Record<string, number>;
}

export async function getCommerceStats(): Promise<CommerceStats> {
  const [
    storeCount,
    activeStoreCount,
    productCount,
    activeProductCount,
    orderCount,
    paidOrderCount,
    grossByCurrency,
    refundedByCurrency,
  ] = await prisma.$transaction([
    prisma.artistStore.count(),
    prisma.artistStore.count({ where: { status: 'ACTIVE' } }),
    prisma.product.count(),
    prisma.product.count({ where: { status: 'ACTIVE' } }),
    prisma.commerceOrder.count(),
    prisma.commerceOrder.count({
      where: { status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED'] } },
    }),
    prisma.commerceOrder.groupBy({
      by: ['currency'],
      orderBy: { currency: 'asc' },
      _sum: { totalCents: true },
      where: { status: { in: ['PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REFUNDED'] } },
    }),
    prisma.commerceRefund.groupBy({
      by: ['currency'],
      orderBy: { currency: 'asc' },
      _sum: { amountCents: true },
      where: { status: 'SUCCEEDED' },
    }),
  ]);
  const toMap = (rows: { currency: string; _sum: { totalCents?: unknown; amountCents?: unknown } }[]) => {
    const m: Record<string, number> = {};
    for (const r of rows) {
      m[r.currency] = Number(r._sum.totalCents ?? r._sum.amountCents ?? 0);
    }
    return m;
  };
  return {
    storeCount,
    activeStoreCount,
    productCount,
    activeProductCount,
    orderCount,
    paidOrderCount,
    grossCentsByCurrency: toMap(grossByCurrency as never),
    refundedCentsByCurrency: toMap(refundedByCurrency as never),
  };
}

// --------------------------------------------------------------- products ---

export interface CreateProductInput {
  storeId: string;
  title: string;
  description?: string;
  type: ProductType;
  priceCents: number;
  sku?: string;
  imageUrl?: string;
  trackId?: string;
  albumId?: string;
  status?: 'DRAFT' | 'ACTIVE';
}

async function assertCatalogRef(
  artistId: string,
  trackId: string | undefined,
  albumId: string | undefined,
  db: Db,
): Promise<void> {
  // Catalog references are IDs only and must belong to the same artist —
  // an artist can never attach another artist's content (Phase 29 rule).
  if (trackId) {
    const track = await db.track.findUnique({
      where: { id: trackId },
      select: { artistId: true },
    });
    if (!track || track.artistId !== artistId) throw notFound('Track not found.');
  }
  if (albumId) {
    const album = await db.album.findUnique({
      where: { id: albumId },
      select: { artistId: true },
    });
    if (!album || album.artistId !== artistId) throw notFound('Album not found.');
  }
}

function assertPrice(priceCents: number): void {
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) {
    throw badRequest('priceCents must be a positive integer (minor units).');
  }
}

export async function createProduct(
  user: AuthUser,
  input: CreateProductInput,
  limits: CommerceLimits,
): Promise<ProductDto> {
  const managed = await requireManagedStore(user, input.storeId);
  const artist = await requireManagedArtist(user, managed.artistId);
  const title = input.title.trim();
  if (!title || title.length > limits.productTitleMaxLength) {
    throw badRequest(`Product title must be 1–${limits.productTitleMaxLength} characters.`);
  }
  if (input.description && input.description.length > limits.productDescriptionMaxLength) {
    throw badRequest(`Product description is too long (max ${limits.productDescriptionMaxLength}).`);
  }
  if (!PRODUCT_TYPES.includes(input.type)) throw badRequest('Unknown product type.');
  assertPrice(input.priceCents);
  const status = input.status ?? 'DRAFT';
  if (status !== 'DRAFT' && status !== 'ACTIVE') {
    throw badRequest('New products start as DRAFT or ACTIVE.');
  }

  const product = await prisma.$transaction(async (tx) => {
    await assertCatalogRef(artist.id, input.trackId, input.albumId, tx);
    const row = await tx.product.create({
      data: {
        storeId: managed.id,
        artistId: artist.id,
        title,
        description: input.description?.trim() || null,
        type: input.type,
        status,
        priceCents: input.priceCents,
        currency: managed.currency,
        sku: input.sku?.trim() || null,
        imageUrl: input.imageUrl ?? null,
        trackId: input.trackId ?? null,
        albumId: input.albumId ?? null,
      },
      include: productInclude,
    });
    // Every product gets a product-level inventory row (variant rows are
    // added with variants). Starts at zero — the artist stocks it.
    await tx.inventoryItem.create({
      data: { productId: row.id, quantityAvailable: 0, quantityReserved: 0, quantitySold: 0 },
    });
    await recordAuditEvent(
      {
        actor: user,
        action: 'commerce.product.created',
        targetType: 'product',
        targetId: row.id,
        metadata: { storeId: managed.id, type: input.type, status },
      },
      tx,
    );
    return row;
  });
  const full = await prisma.product.findUniqueOrThrow({
    where: { id: product.id },
    include: productInclude,
  });
  return toProductDto(full, true);
}

export interface UpdateProductInput {
  title?: string;
  description?: string | null;
  type?: ProductType;
  priceCents?: number;
  sku?: string | null;
  imageUrl?: string | null;
  trackId?: string | null;
  albumId?: string | null;
  status?: ProductStatus;
}

/**
 * Artist-driven status transitions. REMOVED is moderation-only (see
 * moderateProduct); SOLD_OUT is system-managed (see setInventory) but may
 * also be set manually when the artist knows stock is gone.
 */
const PRODUCT_TRANSITIONS: Record<ProductStatus, readonly ProductStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['PAUSED', 'SOLD_OUT', 'ARCHIVED'],
  PAUSED: ['ACTIVE', 'ARCHIVED'],
  SOLD_OUT: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
  REMOVED: [],
};

export async function updateProduct(
  user: AuthUser,
  productId: string,
  input: UpdateProductInput,
  limits: CommerceLimits,
): Promise<ProductDto> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { store: { include: { artist: { select: { ownerUserId: true } } } } },
  });
  if (!product) throw notFound('Product not found.');
  if (!canManageStore(user, product.store)) throw forbidden('You do not manage this product.');
  if (input.status === 'REMOVED' || product.status === 'REMOVED') {
    throw forbidden('Moderation states are managed through the moderation workflow.');
  }

  const data: Prisma.ProductUpdateInput = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title || title.length > limits.productTitleMaxLength) {
      throw badRequest(`Product title must be 1–${limits.productTitleMaxLength} characters.`);
    }
    data.title = title;
  }
  if (input.description !== undefined) {
    if (input.description && input.description.length > limits.productDescriptionMaxLength) {
      throw badRequest(
        `Product description is too long (max ${limits.productDescriptionMaxLength}).`,
      );
    }
    data.description = input.description?.trim() || null;
  }
  if (input.type !== undefined) {
    if (!PRODUCT_TYPES.includes(input.type)) throw badRequest('Unknown product type.');
    data.type = input.type;
  }
  if (input.priceCents !== undefined) {
    assertPrice(input.priceCents);
    data.priceCents = input.priceCents;
  }
  if (input.sku !== undefined) data.sku = input.sku?.trim() || null;
  if (input.imageUrl !== undefined) data.imageUrl = input.imageUrl;
  if (input.trackId !== undefined || input.albumId !== undefined) {
    await assertCatalogRef(
      product.artistId,
      input.trackId ?? undefined,
      input.albumId ?? undefined,
      prisma,
    );
    if (input.trackId !== undefined) {
      data.track = input.trackId === null ? { disconnect: true } : { connect: { id: input.trackId } };
    }
    if (input.albumId !== undefined) {
      data.album = input.albumId === null ? { disconnect: true } : { connect: { id: input.albumId } };
    }
  }
  if (input.status !== undefined && input.status !== product.status) {
    if (!PRODUCT_TRANSITIONS[product.status].includes(input.status)) {
      throw unprocessableEntity(
        `Cannot transition product from ${product.status} to ${input.status}.`,
      );
    }
    data.status = input.status;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.product.update({ where: { id: productId }, data });
    await recordAuditEvent(
      {
        actor: user,
        action:
          input.status !== undefined && input.status !== product.status
            ? 'commerce.product.status_changed'
            : 'commerce.product.updated',
        targetType: 'product',
        targetId: productId,
        metadata:
          input.status !== undefined && input.status !== product.status
            ? { oldStatus: product.status, newStatus: input.status }
            : { storeId: product.storeId },
      },
      tx,
    );
    return row;
  });
  const full = await prisma.product.findUniqueOrThrow({
    where: { id: updated.id },
    include: productInclude,
  });
  return toProductDto(full, true);
}

/** Shortcut for the terminal artist lifecycle state. */
export async function archiveProduct(
  user: AuthUser,
  productId: string,
  limits: CommerceLimits,
): Promise<ProductDto> {
  return updateProduct(user, productId, { status: 'ARCHIVED' }, limits);
}

/** Public product read. Non-ACTIVE products are visible to owner/ADMIN only. */
export async function getProduct(productId: string, viewer: AuthUser | null): Promise<ProductDto> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      ...productInclude,
      store: { include: { artist: { select: { ownerUserId: true } } } },
    },
  });
  if (!product) throw notFound('Product not found.');
  const ownerView = !!viewer && canManageStore(viewer, product.store);
  if (product.status !== 'ACTIVE' && !ownerView) throw notFound('Product not found.');
  return toProductDto(product, ownerView);
}

export interface ListProductsQuery extends PaginationQuery {
  q?: string;
  type?: ProductType;
  /** Owner/ADMIN only; public listing is ACTIVE-only. */
  status?: ProductStatus;
}

/** Storefront product listing. Public callers see ACTIVE products only. */
export async function listStoreProducts(
  storeId: string,
  query: ListProductsQuery,
  viewer: AuthUser | null,
): Promise<PageEnvelope<ProductDto>> {
  const store = await prisma.artistStore.findUnique({
    where: { id: storeId },
    include: { artist: { select: { ownerUserId: true } } },
  });
  if (!store) throw notFound('Store not found.');
  const ownerView = !!viewer && canManageStore(viewer, store);
  if (store.status !== 'ACTIVE' && !ownerView) throw notFound('Store not found.');

  const p = parsePagination(query);
  const where: Prisma.ProductWhereInput = { storeId };
  if (ownerView && query.status) {
    where.status = query.status;
  } else {
    // Public storefront surface: ACTIVE only. ARCHIVED/REMOVED/DRAFT/
    // PAUSED/SOLD_OUT never appear here.
    where.status = 'ACTIVE';
  }
  if (query.type) where.type = query.type;
  if (query.q) where.title = { contains: query.q, mode: 'insensitive' };

  const [total, rows] = await prisma.$transaction([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: productInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (p.page - 1) * p.limit,
      take: p.limit,
    }),
  ]);
  return pageEnvelope(
    rows.map((r) => toProductDto(r, ownerView)),
    total,
    p,
  );
}

// --------------------------------------------------------------- variants ---

export interface CreateVariantInput {
  name: string;
  sku?: string;
  priceCents: number;
}

/**
 * Flat variant list per product (size/color). Deliberately not a generic
 * options engine — one name, one SKU, one price, one inventory row.
 */
export async function createVariant(
  user: AuthUser,
  productId: string,
  input: CreateVariantInput,
): Promise<VariantDto> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      store: { include: { artist: { select: { ownerUserId: true } } } },
      _count: { select: { variants: true } },
    },
  });
  if (!product) throw notFound('Product not found.');
  if (!canManageStore(user, product.store)) throw forbidden('You do not manage this product.');
  if (product.status === 'ARCHIVED' || product.status === 'REMOVED') {
    throw unprocessableEntity('Cannot add variants to an archived or removed product.');
  }
  const name = input.name.trim();
  if (!name || name.length > 80) throw badRequest('Variant name must be 1–80 characters.');
  assertPrice(input.priceCents);
  const count = await prisma.productVariant.count({ where: { productId } });
  // Re-count inside the transaction below; this is a fast-path guard.
  void count;

  const variant = await prisma.$transaction(async (tx) => {
    const existing = await tx.productVariant.count({ where: { productId } });
    const max = 50; // mirrored from config; service stays safe if config differs
    if (existing >= max) throw unprocessableEntity(`A product may have at most ${max} variants.`);
    const row = await tx.productVariant.create({
      data: {
        productId,
        name,
        sku: input.sku?.trim() || null,
        priceCents: input.priceCents,
        currency: product.currency,
        sortOrder: existing,
      },
    });
    await tx.inventoryItem.create({
      data: {
        productId,
        variantId: row.id,
        quantityAvailable: 0,
        quantityReserved: 0,
        quantitySold: 0,
      },
    });
    await recordAuditEvent(
      {
        actor: user,
        action: 'commerce.product.variant_created',
        targetType: 'product',
        targetId: productId,
        metadata: { variantId: row.id, variantName: name },
      },
      tx,
    );
    const inv = await tx.inventoryItem.findFirstOrThrow({
      where: { productId, variantId: row.id },
    });
    return { ...row, availableQuantity: inv.quantityAvailable };
  });
  return {
    id: variant.id,
    name: variant.name,
    sku: variant.sku,
    priceCents: variant.priceCents,
    currency: variant.currency,
    availableQuantity: variant.availableQuantity,
  };
}

// -------------------------------------------------------------- inventory ---

/** Update a variant's name, SKU, or price. */
export async function updateVariant(
  user: AuthUser,
  productId: string,
  variantId: string,
  input: { name?: string; sku?: string | null; priceCents?: number },
): Promise<VariantDto> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { store: { include: { artist: { select: { ownerUserId: true } } } } },
  });
  if (!product) throw notFound('Product not found.');
  if (!canManageStore(user, product.store)) throw forbidden('You do not manage this product.');
  if (product.status === 'ARCHIVED' || product.status === 'REMOVED') {
    throw unprocessableEntity('Cannot edit variants of an archived or removed product.');
  }
  const variant = await prisma.productVariant.findFirst({ where: { id: variantId, productId } });
  if (!variant) throw notFound('Variant not found.');

  const data: Prisma.ProductVariantUpdateInput = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 80) throw badRequest('Variant name must be 1–80 characters.');
    data.name = name;
  }
  if (input.sku !== undefined) data.sku = input.sku?.trim() || null;
  if (input.priceCents !== undefined) {
    assertPrice(input.priceCents);
    data.priceCents = input.priceCents;
  }
  const updated = await prisma.productVariant.update({ where: { id: variantId }, data });
  await recordAuditEvent({
    actor: user,
    action: 'commerce.product.variant_updated',
    targetType: 'product',
    targetId: productId,
    metadata: { variantId, variantName: updated.name },
  });
  const inv = await prisma.inventoryItem.findFirst({ where: { productId, variantId } });
  return {
    id: updated.id,
    name: updated.name,
    sku: updated.sku,
    priceCents: updated.priceCents,
    currency: updated.currency,
    availableQuantity: (inv?.quantityAvailable ?? 0) - (inv?.quantityReserved ?? 0),
  };
}

/** Delete a variant that has never been ordered. */
export async function deleteVariant(
  user: AuthUser,
  productId: string,
  variantId: string,
): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { store: { include: { artist: { select: { ownerUserId: true } } } } },
  });
  if (!product) throw notFound('Product not found.');
  if (!canManageStore(user, product.store)) throw forbidden('You do not manage this product.');
  const variant = await prisma.productVariant.findFirst({ where: { id: variantId, productId } });
  if (!variant) throw notFound('Variant not found.');
  const ordered = await prisma.commerceOrderItem.count({ where: { variantId } });
  if (ordered > 0) {
    throw unprocessableEntity('Cannot delete a variant that has been ordered. Archive the product instead.');
  }
  await prisma.$transaction(async (tx) => {
    await tx.inventoryItem.deleteMany({ where: { productId, variantId } });
    await tx.cartItem.deleteMany({ where: { variantId } });
    await tx.productVariant.delete({ where: { id: variantId } });
    await recordAuditEvent(
      {
        actor: user,
        action: 'commerce.product.variant_deleted',
        targetType: 'product',
        targetId: productId,
        metadata: { variantId, variantName: variant.name },
      },
      tx,
    );
  });
}

/**
 * Set absolute available quantity for one purchasable unit. Reserved units
 * are never clobbered: available is the sellable pool, reserved is already
 * spoken for by in-flight checkouts.
 */
/** Read inventory rows for a product. Store owner or ADMIN only. */
export async function getInventory(
  user: AuthUser,
  productId: string,
): Promise<InventoryDto[]> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      store: { include: { artist: { select: { ownerUserId: true } } } },
      inventory: true,
    },
  });
  if (!product) throw notFound('Product not found.');
  if (!canManageStore(user, product.store)) throw forbidden('You do not manage this product.');
  return product.inventory.map((row) => ({
    productId: row.productId,
    variantId: row.variantId,
    quantityAvailable: row.quantityAvailable,
    quantityReserved: row.quantityReserved,
    quantitySold: row.quantitySold,
  }));
}

export async function setInventory(
  user: AuthUser,
  productId: string,
  variantId: string | undefined,
  quantityAvailable: number,
): Promise<InventoryDto[]> {
  if (!Number.isSafeInteger(quantityAvailable) || quantityAvailable < 0) {
    throw badRequest('quantityAvailable must be a non-negative integer.');
  }
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      store: { include: { artist: { select: { ownerUserId: true } } } },
      variants: { select: { id: true } },
      inventory: true,
    },
  });
  if (!product) throw notFound('Product not found.');
  if (!canManageStore(user, product.store)) throw forbidden('You do not manage this product.');
  if (product.status === 'ARCHIVED' || product.status === 'REMOVED') {
    throw unprocessableEntity('Cannot restock an archived or removed product.');
  }

  const hasVariants = product.variants.length > 0;
  if (hasVariants && !variantId) {
    throw badRequest('This product has variants: set inventory per variant.');
  }
  if (!hasVariants && variantId) {
    throw badRequest('This product has no variants.');
  }
  if (variantId && !product.variants.some((v) => v.id === variantId)) {
    throw notFound('Variant not found.');
  }

  return prisma.$transaction(async (tx) => {
    const where = variantId
      ? { productId, variantId }
      : { productId, variantId: null };
    const row = await tx.inventoryItem.findFirst({ where });
    if (!row) throw notFound('Inventory record not found.');
    // Never clobber reserved units: available is total on-hand stock and
    // reserved units are a subset of it. An artist cannot set available
    // below what is already reserved for unpaid orders.
    const newAvailable = Math.max(quantityAvailable, row.quantityReserved);
    await tx.inventoryItem.update({
      where: { id: row.id },
      data: { quantityAvailable: newAvailable },
    });

    // System-managed SOLD_OUT: when every purchasable unit of an ACTIVE
    // product hits zero available, the product flips to SOLD_OUT; restocking
    // any unit flips it back to ACTIVE.
    const units = await tx.inventoryItem.findMany({ where: { productId } });
    const anyAvailable = units.some((u) => u.quantityAvailable - u.quantityReserved > 0);
    if (!anyAvailable && product.status === 'ACTIVE') {
      await tx.product.update({ where: { id: productId }, data: { status: 'SOLD_OUT' } });
      await recordAuditEvent(
        {
          actor: user,
          action: 'commerce.product.status_changed',
          targetType: 'product',
          targetId: productId,
          metadata: { oldStatus: 'ACTIVE', newStatus: 'SOLD_OUT', reason: 'stock_depleted' },
        },
        tx,
      );
    } else if (anyAvailable && product.status === 'SOLD_OUT') {
      await tx.product.update({ where: { id: productId }, data: { status: 'ACTIVE' } });
      await recordAuditEvent(
        {
          actor: user,
          action: 'commerce.product.status_changed',
          targetType: 'product',
          targetId: productId,
          metadata: { oldStatus: 'SOLD_OUT', newStatus: 'ACTIVE', reason: 'restocked' },
        },
        tx,
      );
    }

    await recordAuditEvent(
      {
        actor: user,
        action: 'commerce.inventory.updated',
        targetType: 'product',
        targetId: productId,
        metadata: { variantId: variantId ?? null, quantityAvailable },
      },
      tx,
    );
    const all = await tx.inventoryItem.findMany({ where: { productId } });
    return all.map((u) => ({
      productId: u.productId,
      variantId: u.variantId,
      quantityAvailable: u.quantityAvailable,
      quantityReserved: u.quantityReserved,
      quantitySold: u.quantitySold,
    }));
  });
}

// ---------------------------------------------------------------- images ---

export async function addProductImage(
  user: AuthUser,
  productId: string,
  imageUrl: string,
  altText?: string,
): Promise<ProductImageDto> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { store: { include: { artist: { select: { ownerUserId: true } } } } },
  });
  if (!product) throw notFound('Product not found.');
  if (!canManageStore(user, product.store)) throw forbidden('You do not manage this product.');
  if (!imageUrl || imageUrl.length > 2000) throw badRequest('imageUrl is required (max 2000 chars).');
  const count = await prisma.productImage.count({ where: { productId } });
  const row = await prisma.productImage.create({
    data: { productId, imageUrl, altText: altText?.slice(0, 200) ?? null, sortOrder: count },
  });
  return { id: row.id, imageUrl: row.imageUrl, altText: row.altText, sortOrder: row.sortOrder };
}

export async function removeProductImage(user: AuthUser, imageId: string): Promise<void> {
  const image = await prisma.productImage.findUnique({
    where: { id: imageId },
    include: { product: { include: { store: { include: { artist: { select: { ownerUserId: true } } } } } } },
  });
  if (!image) throw notFound('Image not found.');
  if (!canManageStore(user, image.product.store)) {
    throw forbidden('You do not manage this product.');
  }
  await prisma.productImage.delete({ where: { id: imageId } });
}

/** Reorder a product's images. imageIds must be exactly the product's images. */
export async function reorderProductImages(
  user: AuthUser,
  productId: string,
  imageIds: string[],
): Promise<ProductImageDto[]> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { store: { include: { artist: { select: { ownerUserId: true } } } } },
  });
  if (!product) throw notFound('Product not found.');
  if (!canManageStore(user, product.store)) throw forbidden('You do not manage this product.');
  const existing = await prisma.productImage.findMany({ where: { productId } });
  const existingIds = new Set(existing.map((i) => i.id));
  if (imageIds.length !== existing.length || !imageIds.every((id) => existingIds.has(id))) {
    throw badRequest('imageIds must contain exactly the product\u2019s image ids.');
  }
  await prisma.$transaction(
    imageIds.map((id, index) =>
      prisma.productImage.update({ where: { id }, data: { sortOrder: index } }),
    ),
  );
  const rows = await prisma.productImage.findMany({
    where: { productId },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, imageUrl: r.imageUrl, altText: r.altText, sortOrder: r.sortOrder }));
}

// ------------------------------------------------------------- moderation ---

/**
 * ADMIN-only product moderation. REMOVED products are never purchasable;
 * historical order snapshots are untouched. Audited like every admin
 * mutation (Phase 16/17 pattern).
 */
export async function moderateProduct(
  admin: AuthUser,
  productId: string,
  action: 'remove' | 'restore',
): Promise<ProductDto> {
  if (!isAdmin(admin)) throw forbidden('This action requires the ADMIN role.');
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw notFound('Product not found.');
  const target: ProductStatus = action === 'remove' ? 'REMOVED' : 'ACTIVE';
  if (action === 'remove' && product.status === 'REMOVED') {
    throw unprocessableEntity('Product is already removed.');
  }
  if (action === 'restore' && product.status !== 'REMOVED') {
    throw unprocessableEntity('Only removed products can be restored.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.product.update({ where: { id: productId }, data: { status: target } });
    await recordAuditEvent(
      {
        actor: admin,
        action: action === 'remove' ? 'commerce.product.removed' : 'commerce.product.restored',
        targetType: 'product',
        targetId: productId,
        metadata: { oldStatus: product.status, newStatus: target },
      },
      tx,
    );
    return row;
  });
  const full = await prisma.product.findUniqueOrThrow({
    where: { id: updated.id },
    include: productInclude,
  });
  return toProductDto(full, true);
}

/**
 * ADMIN-only store suspension. Suspended stores vanish from public
 * storefront surfaces and their products are not purchasable.
 */
export async function moderateStore(
  admin: AuthUser,
  storeId: string,
  action: 'suspend' | 'reinstate',
): Promise<StoreDto> {
  if (!isAdmin(admin)) throw forbidden('This action requires the ADMIN role.');
  const store = await prisma.artistStore.findUnique({ where: { id: storeId } });
  if (!store) throw notFound('Store not found.');
  const target: StoreStatus = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
  if (action === 'suspend' && store.status === 'SUSPENDED') {
    throw unprocessableEntity('Store is already suspended.');
  }
  if (action === 'reinstate' && store.status !== 'SUSPENDED') {
    throw unprocessableEntity('Only suspended stores can be reinstated.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.artistStore.update({ where: { id: storeId }, data: { status: target } });
    await recordAuditEvent(
      {
        actor: admin,
        action: action === 'suspend' ? 'commerce.store.suspended' : 'commerce.store.reinstated',
        targetType: 'artist_store',
        targetId: storeId,
        metadata: { oldStatus: store.status, newStatus: target },
      },
      tx,
    );
    return row;
  });
  const full = await prisma.artistStore.findUniqueOrThrow({
    where: { id: updated.id },
    include: { artist: { select: { id: true, name: true, verified: true } } },
  });
  return toStoreDto(full);
}
