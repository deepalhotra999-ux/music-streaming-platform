// Phase 30 — artist commerce. JSON Schemas for the commerce API.
//
// Design notes:
// - Money is integer minor units everywhere; currency is an explicit
//   3-letter code on every monetary object. No floats in schemas.
// - Client-submitted prices do not exist: cart and checkout bodies carry
//   product/variant references and quantities only.
// - Artist identity is never accepted from the client: routes derive the
//   user id from the authenticated request; the service derives artist
//   ownership from the artist row.
// - Shipping addresses appear only in order DTOs served to the buyer, the
//   store owner, or ADMIN — never on public surfaces.

import { paginationQuerySchema } from '../../http/pagination.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const cents = { type: 'integer', minimum: 0 } as const;
const priceCents = { type: 'integer', minimum: 1 } as const;
const currency = { type: 'string', pattern: '^[A-Z]{3}$' } as const;

export const storeStatusSchema = {
  type: 'string',
  enum: ['ACTIVE', 'PAUSED', 'SUSPENDED'],
} as const;

export const productTypeSchema = {
  type: 'string',
  enum: ['APPAREL', 'ACCESSORY', 'MUSIC', 'ART', 'OTHER'],
} as const;

export const productStatusSchema = {
  type: 'string',
  enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'SOLD_OUT', 'ARCHIVED', 'REMOVED'],
} as const;

export const orderStatusSchema = {
  type: 'string',
  enum: [
    'PENDING_PAYMENT',
    'PAID',
    'PROCESSING',
    'SHIPPED',
    'DELIVERED',
    'CANCELED',
    'REFUNDED',
  ],
} as const;

const storeArtistRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'verified'],
  properties: { id: uuid, name: { type: 'string' }, verified: { type: 'boolean' } },
} as const;

export const storeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'artist',
    'name',
    'status',
    'currency',
    'shippingFlatCents',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    artist: storeArtistRefSchema,
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    status: storeStatusSchema,
    imageUrl: { type: ['string', 'null'] },
    bannerUrl: { type: ['string', 'null'] },
    contactEmail: { type: ['string', 'null'] },
    contactUrl: { type: ['string', 'null'] },
    currency,
    shippingFlatCents: cents,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const createStoreBody = {
  type: 'object',
  additionalProperties: false,
  required: ['artistId', 'name'],
  properties: {
    artistId: uuid,
    name: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', maxLength: 2000 },
    currency,
    imageUrl: { type: 'string', maxLength: 2000 },
    bannerUrl: { type: 'string', maxLength: 2000 },
    contactEmail: { type: 'string', maxLength: 320 },
    contactUrl: { type: 'string', maxLength: 2000 },
    shippingFlatCents: cents,
  },
} as const;

export const updateStoreBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: ['string', 'null'], maxLength: 2000 },
    status: storeStatusSchema,
    imageUrl: { type: ['string', 'null'], maxLength: 2000 },
    bannerUrl: { type: ['string', 'null'], maxLength: 2000 },
    contactEmail: { type: ['string', 'null'], maxLength: 320 },
    contactUrl: { type: ['string', 'null'], maxLength: 2000 },
    shippingFlatCents: cents,
  },
} as const;

const variantSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'priceCents', 'currency', 'availableQuantity'],
  properties: {
    id: uuid,
    name: { type: 'string' },
    sku: { type: ['string', 'null'] },
    priceCents,
    currency,
    availableQuantity: cents,
  },
} as const;

const inventorySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'productId',
    'variantId',
    'quantityAvailable',
    'quantityReserved',
    'quantitySold',
  ],
  properties: {
    productId: uuid,
    variantId: { type: ['string', 'null'], format: 'uuid' },
    quantityAvailable: cents,
    quantityReserved: cents,
    quantitySold: cents,
  },
} as const;

const productImageSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'imageUrl', 'sortOrder'],
  properties: {
    id: uuid,
    imageUrl: { type: 'string' },
    altText: { type: ['string', 'null'] },
    sortOrder: { type: 'integer', minimum: 0 },
  },
} as const;

export const productSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'storeId',
    'artistId',
    'title',
    'type',
    'status',
    'priceCents',
    'currency',
    'variants',
    'images',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    storeId: uuid,
    artistId: uuid,
    title: { type: 'string' },
    description: { type: ['string', 'null'] },
    type: productTypeSchema,
    status: productStatusSchema,
    priceCents,
    currency,
    sku: { type: ['string', 'null'] },
    imageUrl: { type: ['string', 'null'] },
    images: { type: 'array', items: productImageSchema },
    variants: { type: 'array', items: variantSchema },
    trackRef: {
      type: ['object', 'null'],
      properties: { id: uuid, title: { type: 'string' } },
    },
    albumRef: {
      type: ['object', 'null'],
      properties: { id: uuid, title: { type: 'string' } },
    },
    inventory: { type: ['array', 'null'], items: inventorySchema },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const createProductBody = {
  type: 'object',
  additionalProperties: false,
  required: ['storeId', 'title', 'type', 'priceCents'],
  properties: {
    storeId: uuid,
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 5000 },
    type: productTypeSchema,
    priceCents,
    sku: { type: 'string', maxLength: 80 },
    imageUrl: { type: 'string', maxLength: 2000 },
    trackId: uuid,
    albumId: uuid,
    status: { type: 'string', enum: ['DRAFT', 'ACTIVE'] },
  },
} as const;

export const updateProductBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: ['string', 'null'], maxLength: 5000 },
    type: productTypeSchema,
    priceCents,
    sku: { type: ['string', 'null'], maxLength: 80 },
    imageUrl: { type: ['string', 'null'], maxLength: 2000 },
    trackId: { type: ['string', 'null'], format: 'uuid' },
    albumId: { type: ['string', 'null'], format: 'uuid' },
    status: productStatusSchema,
  },
} as const;

export const createVariantBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'priceCents'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    sku: { type: 'string', maxLength: 80 },
    priceCents,
  },
} as const;

export const setInventoryBody = {
  type: 'object',
  additionalProperties: false,
  required: ['quantityAvailable'],
  properties: {
    variantId: uuid,
    quantityAvailable: { type: 'integer', minimum: 0 },
  },
} as const;

export const addProductImageBody = {
  type: 'object',
  additionalProperties: false,
  required: ['imageUrl'],
  properties: {
    imageUrl: { type: 'string', minLength: 1, maxLength: 2000 },
    altText: { type: 'string', maxLength: 200 },
  },
} as const;

export const storeProductsQuery = {
  ...paginationQuerySchema,
  properties: {
    ...paginationQuerySchema.properties,
    q: { type: 'string', maxLength: 200 },
    type: productTypeSchema,
    status: productStatusSchema,
  },
} as const;

export const storesQuery = {
  ...paginationQuerySchema,
  properties: {
    ...paginationQuerySchema.properties,
    q: { type: 'string', maxLength: 200 },
    status: storeStatusSchema,
  },
} as const;

// ---------------------------------------------------------------- cart ---

const cartLineProductSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'title',
    'status',
    'priceCents',
    'currency',
    'storeId',
    'storeName',
    'storeStatus',
  ],
  properties: {
    id: uuid,
    title: { type: 'string' },
    status: { type: 'string' },
    priceCents,
    currency,
    imageUrl: { type: ['string', 'null'] },
    storeId: uuid,
    storeName: { type: 'string' },
    storeStatus: { type: 'string' },
  },
} as const;

const cartLineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'productId', 'variantId', 'quantity', 'product', 'availableQuantity', 'purchasable'],
  properties: {
    id: uuid,
    productId: uuid,
    variantId: { type: ['string', 'null'], format: 'uuid' },
    quantity: { type: 'integer', minimum: 1 },
    product: cartLineProductSchema,
    variant: {
      type: ['object', 'null'],
      properties: { id: uuid, name: { type: 'string' }, priceCents },
    },
    availableQuantity: cents,
    purchasable: { type: 'boolean' },
  },
} as const;

export const cartSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'storeGroups'],
  properties: {
    items: { type: 'array', items: cartLineSchema },
    storeGroups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['storeId', 'storeName', 'items'],
        properties: {
          storeId: uuid,
          storeName: { type: 'string' },
          items: { type: 'array', items: cartLineSchema },
        },
      },
    },
  },
} as const;

export const addToCartBody = {
  type: 'object',
  additionalProperties: false,
  required: ['productId', 'quantity'],
  properties: {
    productId: uuid,
    variantId: uuid,
    quantity: { type: 'integer', minimum: 1, maximum: 99 },
  },
} as const;

export const updateCartItemBody = {
  type: 'object',
  additionalProperties: false,
  required: ['quantity'],
  properties: {
    quantity: { type: 'integer', minimum: 0, maximum: 99 },
  },
} as const;

// --------------------------------------------------------------- orders ---

const shippingAddressSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'line1', 'city', 'postal', 'country'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    line1: { type: 'string', minLength: 1, maxLength: 200 },
    line2: { type: 'string', maxLength: 200 },
    city: { type: 'string', minLength: 1, maxLength: 200 },
    region: { type: 'string', maxLength: 200 },
    postal: { type: 'string', minLength: 1, maxLength: 200 },
    country: { type: 'string', minLength: 2, maxLength: 2 },
    phone: { type: 'string', maxLength: 50 },
  },
} as const;

const orderItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'productId',
    'productTitle',
    'quantity',
    'unitPriceCents',
    'currency',
  ],
  properties: {
    id: uuid,
    productId: uuid,
    variantId: { type: ['string', 'null'], format: 'uuid' },
    productTitle: { type: 'string' },
    variantName: { type: ['string', 'null'] },
    sku: { type: ['string', 'null'] },
    quantity: { type: 'integer', minimum: 1 },
    unitPriceCents: priceCents,
    currency,
  },
} as const;

const orderPaymentSchema = {
  additionalProperties: false,
  required: ['provider', 'providerPaymentId', 'status', 'amountCents', 'currency'],
  properties: {
    provider: { type: 'string' },
    providerPaymentId: { type: 'string' },
    status: { type: 'string' },
    amountCents: cents,
    currency,
    clientData: { type: 'object' },
  },
} as const;

export const orderSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'orderNumber',
    'storeId',
    'storeName',
    'status',
    'currency',
    'subtotalCents',
    'shippingCents',
    'taxCents',
    'totalCents',
    'items',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    orderNumber: { type: 'string' },
    storeId: uuid,
    storeName: { type: 'string' },
    status: orderStatusSchema,
    currency,
    subtotalCents: cents,
    shippingCents: cents,
    taxCents: cents,
    totalCents: cents,
    items: { type: 'array', items: orderItemSchema },
    payment: { ...orderPaymentSchema, type: ['object', 'null'] as const },
    shippingAddress: { ...shippingAddressSchema, type: ['object', 'null'] as const },
    buyerName: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const checkoutBody = {
  type: 'object',
  additionalProperties: false,
  required: ['idempotencyKey', 'shippingAddress'],
  properties: {
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
    shippingAddress: shippingAddressSchema,
  },
} as const;

export const checkoutResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['order', 'created', 'clientData'],
  properties: {
    order: orderSchema,
    created: { type: 'boolean' },
    clientData: { type: 'object' },
  },
} as const;

export const ordersQuery = {
  ...paginationQuerySchema,
  properties: {
    ...paginationQuerySchema.properties,
    status: orderStatusSchema,
  },
} as const;

export const fulfillmentBody = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['PROCESSING', 'SHIPPED', 'DELIVERED'] },
  },
} as const;

export const refundBody = {
  type: 'object',
  additionalProperties: false,
  required: ['idempotencyKey'],
  properties: {
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
    reason: { type: 'string', maxLength: 500 },
  },
} as const;

export const refundSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'orderId', 'amountCents', 'currency', 'status', 'createdAt'],
  properties: {
    id: uuid,
    orderId: uuid,
    amountCents: cents,
    currency,
    reason: { type: ['string', 'null'] },
    status: { type: 'string' },
    providerRefundId: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const moderateProductBody = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['remove', 'restore'] },
  },
} as const;

export const moderateStoreBody = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['suspend', 'reinstate'] },
  },
} as const;

export const storeIdParams = {
  type: 'object',
  required: ['storeId'],
  additionalProperties: false,
  properties: { storeId: uuid },
} as const;

export const productIdParams = {
  type: 'object',
  required: ['productId'],
  additionalProperties: false,
  properties: { productId: uuid },
} as const;

export const variantIdParams = {
  type: 'object',
  required: ['productId', 'variantId'],
  additionalProperties: false,
  properties: { productId: uuid, variantId: uuid },
} as const;

export const updateVariantBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    sku: { type: ['string', 'null'], maxLength: 80 },
    priceCents,
  },
} as const;

export const orderIdParams = {
  type: 'object',
  required: ['orderId'],
  additionalProperties: false,
  properties: { orderId: uuid },
} as const;

export const cartItemIdParams = {
  type: 'object',
  required: ['itemId'],
  additionalProperties: false,
  properties: { itemId: uuid },
} as const;

export const artistIdParams = {
  type: 'object',
  required: ['artistId'],
  additionalProperties: false,
  properties: { artistId: uuid },
} as const;

export const imageIdParams = {
  type: 'object',
  required: ['imageId'],
  additionalProperties: false,
  properties: { imageId: uuid },
} as const;

export const commerceStatsSchema = {
  type: 'object',
  required: [
    'storeCount',
    'activeStoreCount',
    'productCount',
    'activeProductCount',
    'orderCount',
    'paidOrderCount',
    'grossCentsByCurrency',
    'refundedCentsByCurrency',
  ],
  additionalProperties: false,
  properties: {
    storeCount: { type: 'integer', minimum: 0 },
    activeStoreCount: { type: 'integer', minimum: 0 },
    productCount: { type: 'integer', minimum: 0 },
    activeProductCount: { type: 'integer', minimum: 0 },
    orderCount: { type: 'integer', minimum: 0 },
    paidOrderCount: { type: 'integer', minimum: 0 },
    grossCentsByCurrency: {
      type: 'object',
      additionalProperties: { type: 'integer', minimum: 0 },
    },
    refundedCentsByCurrency: {
      type: 'object',
      additionalProperties: { type: 'integer', minimum: 0 },
    },
  },
} as const;
