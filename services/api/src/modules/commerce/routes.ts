// Phase 30 — artist commerce HTTP routes: thin handlers over the commerce
// services. Identity always comes from the authenticated request; write
// endpoints additionally enforce per-USER rate buckets (server identity,
// not IP) on top of the platform IP bucket.
//
// Money rules enforced here:
// - No endpoint accepts client-submitted prices. Checkout recomputes
//   everything server-side.
// - POST /v1/commerce/orders/:orderId/confirm-payment VERIFIES with the
//   provider before moving money — a client callback is never trusted.
// - Webhooks are signature-verified and idempotent.

import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import { badRequest, notFound, problemSchema, unauthorized } from '../../http/errors.js';
import { metrics } from '../../http/metrics.js';
import { pageOf, type PaginationQuery } from '../../http/pagination.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import { checkUserRateLimit, resetCommerceRateLimits } from './rateLimit.js';
import {
  addProductImageBody,
  addToCartBody,
  artistIdParams,
  cartItemIdParams,
  cartSchema,
  checkoutBody,
  checkoutResponseSchema,
  createProductBody,
  createStoreBody,
  createVariantBody,
  fulfillmentBody,
  imageIdParams,
  moderateProductBody,
  moderateStoreBody,
  orderIdParams,
  orderSchema,
  ordersQuery,
  productIdParams,
  productSchema,
  refundBody,
  refundSchema,
  setInventoryBody,
  storeIdParams,
  storeProductsQuery,
  storeSchema,
  storesQuery,
  updateCartItemBody,
  updateProductBody,
  updateStoreBody,
  updateVariantBody,
  variantIdParams,
  commerceStatsSchema,
} from './schemas.js';
import {
  archiveProduct,
  addProductImage,
  commerceLimits,
  createProduct,
  createStore,
  createVariant,
  getCommerceStats,
  getInventory,
  getProduct,
  getStore,
  getStoreByArtist,
  listProductsAdmin,
  listStoreProducts,
  listStoresAdmin,
  moderateProduct,
  moderateStore,
  removeProductImage,
  reorderProductImages,
  setInventory,
  updateProduct,
  updateStore,
  updateVariant,
  deleteVariant,
  type ListProductsAdminQuery,
  type CreateProductInput,
  type CreateStoreInput,
  type CreateVariantInput,
  type ListProductsQuery,
  type ListStoresQuery,
  type UpdateProductInput,
  type UpdateStoreInput,
} from './service.js';
import {
  addToCart,
  clearCart,
  getCart,
  removeCartItem,
  updateCartItem,
  type AddToCartInput,
} from './cart.js';
import {
  cancelOrder,
  checkout,
  confirmPayment,
  getOrder,
  listMyOrders,
  listOrdersAdmin,
  listStoreOrders,
  refundOrder,
  retryPayment,
  updateFulfillment,
  type CheckoutInput,
  type ListOrdersQuery,
} from './orders.js';
import {
  applyVerifiedPayment,
  recordPaymentEvent,
} from './paymentState.js';
import {
  buildMockWebhookPayload,
  completeMockPayment,
  resolvePaymentProvider,
  setMockPaymentScenario,
  type CommercePaymentProvider,
  type NormalizedPaymentEvent,
} from './payments/index.js';
import { prisma } from '../../db.js';

const commerceErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
  429: problemSchema,
};

/** Capture the raw request body for webhook signature verification. */
async function captureRawBody(
  request: FastifyRequest,
  _reply: unknown,
  payload: AsyncIterable<Buffer>,
): Promise<Readable> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  (request as { rawBody?: string }).rawBody = raw;
  return Readable.from([raw]);
}

interface WebhookResult {
  ok: boolean;
  applied: boolean;
  eventType: string | null;
}

async function handleWebhookEvent(
  provider: CommercePaymentProvider,
  rawBody: string,
  signature: string | undefined,
): Promise<WebhookResult> {
  if (!provider.verifyWebhookSignature(rawBody, signature)) {
    metrics.recordCommerceWebhook('failed');
    throw unauthorized('Invalid webhook signature.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    metrics.recordCommerceWebhook('failed');
    throw badRequest('Webhook body must be JSON.');
  }
  const event: NormalizedPaymentEvent | null = await provider.normalizeWebhookEvent(raw);
  if (!event) {
    metrics.recordCommerceWebhook('received');
    return { ok: true, applied: false, eventType: null };
  }

  const payment = await prisma.commercePayment.findFirst({
    where: { provider: provider.id, providerPaymentId: event.providerPaymentId },
    include: { order: true },
  });
  if (!payment) {
    // Unknown payment: acknowledge so the provider stops retrying, but
    // change nothing. Logged via audit for visibility.
    metrics.recordCommerceWebhook('received');
    return { ok: true, applied: false, eventType: event.eventType };
  }
  const recorded = await recordPaymentEvent(payment.id, event);

  if (!recorded) {
    metrics.recordCommerceWebhook('duplicates');
    return { ok: true, applied: false, eventType: event.eventType };
  }
  const verified = await provider.verifyPayment(event.providerPaymentId);
  const result = await applyVerifiedPayment(payment.id, {
    verified,
    actorId: null,
    eventRecorded: true,
  });
  metrics.recordCommerceWebhook('received');
  return { ok: true, applied: result.applied, eventType: event.eventType };
}

const webhookResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'applied'],
  properties: {
    ok: { type: 'boolean' },
    applied: { type: 'boolean' },
    eventType: { type: ['string', 'null'] },
  },
} as const;

export async function commerceRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);
  const limits = commerceLimits(config);
  const windowMs = config.rateLimits.windowMs;
  const provider = resolvePaymentProvider(config);
  const userBucket = (userId: string, action: string, max: number): void =>
    checkUserRateLimit(userId, action, max, windowMs);

  // ------------------------------------------------------------ stores ---

  app.post<{ Body: CreateStoreInput }>(
    '/v1/commerce/stores',
    {
      preHandler: [app.authenticate, requireRole('ARTIST')],
      schema: {
        tags: ['Commerce'],
        summary: 'Create an artist storefront',
        description:
          'ARTIST-only. Creates one storefront for a verified artist the ' +
          'caller owns (artistId is validated against the caller; one ' +
          'store per artist). Per-user rate limited.',
        security: [{ bearerAuth: [] }],
        body: createStoreBody,
        response: { 201: storeSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'commerce.store_create', config.rateLimits.commerceStoreCreate);
      const store = await createStore(req.authUser!, req.body, limits);
      return reply.code(201).send(store);
    },
  );

  app.patch<{ Params: { storeId: string }; Body: UpdateStoreInput }>(
    '/v1/commerce/stores/:storeId',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Update store settings',
        description:
          'Store owner or ADMIN. Artists may toggle ACTIVE/PAUSED; only ' +
          'ADMIN may suspend or reinstate a store.',
        security: [{ bearerAuth: [] }],
        params: storeIdParams,
        body: updateStoreBody,
        response: { 200: storeSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const store = await updateStore(req.authUser!, req.params.storeId, req.body, limits);
      return reply.code(200).send(store);
    },
  );

  app.get<{ Params: { storeId: string } }>(
    '/v1/commerce/stores/:storeId',
    {
      preHandler: [app.authenticateOptional],
      schema: {
        tags: ['Commerce'],
        summary: 'Get an artist storefront',
        description:
          'Public. ACTIVE stores are visible to everyone; PAUSED/SUSPENDED ' +
          'stores are visible to the owner and ADMIN only.',
        params: storeIdParams,
        response: { 200: storeSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const store = await getStore(req.params.storeId, req.authUser ?? null);
      return reply.code(200).send(store);
    },
  );

  app.get<{ Params: { artistId: string } }>(
    '/v1/commerce/artists/:artistId/store',
    {
      preHandler: [app.authenticateOptional],
      schema: {
        tags: ['Commerce'],
        summary: "Get an artist's storefront",
        description: 'Public. Same visibility rules as the storefront read.',
        params: artistIdParams,
        response: { 200: storeSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const store = await getStoreByArtist(req.params.artistId, req.authUser ?? null);
      return reply.code(200).send(store);
    },
  );

  // ----------------------------------------------------------- products ---

  app.post<{ Body: CreateProductInput }>(
    '/v1/commerce/products',
    {
      preHandler: [app.authenticate, requireRole('ARTIST')],
      schema: {
        tags: ['Commerce'],
        summary: 'Create a product',
        description:
          'ARTIST-only. Creates a product in a store the caller owns ' +
          '(ownership derived server-side from the store). Starts as ' +
          'DRAFT or ACTIVE. Price is integer minor units; currency must ' +
          'match the store. Per-user rate limited.',
        security: [{ bearerAuth: [] }],
        body: createProductBody,
        response: { 201: productSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(
        req.authUser!.id,
        'commerce.product_create',
        config.rateLimits.commerceProductCreate,
      );
      const product = await createProduct(req.authUser!, req.body, limits);
      return reply.code(201).send(product);
    },
  );

  app.patch<{ Params: { productId: string }; Body: UpdateProductInput }>(
    '/v1/commerce/products/:productId',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Update a product',
        description:
          'Store owner or ADMIN. Price changes apply to future orders ' +
          'only — historical order snapshots are immutable. Moderation ' +
          'states (REMOVED) are managed through the moderation workflow.',
        security: [{ bearerAuth: [] }],
        params: productIdParams,
        body: updateProductBody,
        response: { 200: productSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const product = await updateProduct(req.authUser!, req.params.productId, req.body, limits);
      return reply.code(200).send(product);
    },
  );

  app.post<{ Params: { productId: string } }>(
    '/v1/commerce/products/:productId/archive',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Archive a product',
        description:
          'Store owner or ADMIN. Archived products are not purchasable; ' +
          'historical orders keep their snapshots.',
        security: [{ bearerAuth: [] }],
        params: productIdParams,
        response: { 200: productSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const product = await archiveProduct(req.authUser!, req.params.productId, limits);
      return reply.code(200).send(product);
    },
  );

  app.get<{ Params: { productId: string } }>(
    '/v1/commerce/products/:productId',
    {
      preHandler: [app.authenticateOptional],
      schema: {
        tags: ['Commerce'],
        summary: 'Get a product',
        description:
          'Public for ACTIVE products; non-ACTIVE products are visible ' +
          'to the owner and ADMIN only.',
        params: productIdParams,
        response: { 200: productSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const product = await getProduct(req.params.productId, req.authUser ?? null);
      return reply.code(200).send(product);
    },
  );

  app.get<{ Params: { storeId: string }; Querystring: ListProductsQuery }>(
    '/v1/commerce/stores/:storeId/products',
    {
      preHandler: [app.authenticateOptional],
      schema: {
        tags: ['Commerce'],
        summary: 'List storefront products',
        description:
          'Public. Only ACTIVE products appear on the normal storefront ' +
          'surface; owners/ADMIN may filter by any status. Scoped product ' +
          'search only — commerce never touches music catalog search.',
        params: storeIdParams,
        querystring: storeProductsQuery,
        response: { 200: pageOf(productSchema), 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const page = await listStoreProducts(
        req.params.storeId,
        req.query,
        req.authUser ?? null,
      );
      return reply.code(200).send(page);
    },
  );

  app.post<{ Params: { productId: string }; Body: CreateVariantInput }>(
    '/v1/commerce/products/:productId/variants',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Add a product variant',
        description:
          'Store owner or ADMIN. Flat variant (name/SKU/price); each ' +
          'variant gets its own inventory row.',
        security: [{ bearerAuth: [] }],
        params: productIdParams,
        body: createVariantBody,
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              sku: { type: ['string', 'null'] },
              priceCents: { type: 'integer' },
              currency: { type: 'string' },
              availableQuantity: { type: 'integer' },
            },
          },
          ...commerceErrors,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(
        req.authUser!.id,
        'commerce.variant_create',
        config.rateLimits.commerceVariantCreate,
      );
      const variant = await createVariant(req.authUser!, req.params.productId, req.body);
      return reply.code(201).send(variant);
    },
  );

  app.patch<{ Params: { productId: string; variantId: string }; Body: { name?: string; sku?: string | null; priceCents?: number } }>(
    '/v1/commerce/products/:productId/variants/:variantId',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Update a product variant',
        description: 'Store owner or ADMIN.',
        security: [{ bearerAuth: [] }],
        params: variantIdParams,
        body: updateVariantBody,
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              sku: { type: ['string', 'null'] },
              priceCents: { type: 'integer' },
              currency: { type: 'string' },
              availableQuantity: { type: 'integer' },
            },
          },
          ...commerceErrors,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const variant = await updateVariant(req.authUser!, req.params.productId, req.params.variantId, req.body);
      return reply.code(200).send(variant);
    },
  );

  app.delete<{ Params: { productId: string; variantId: string } }>(
    '/v1/commerce/products/:productId/variants/:variantId',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Delete a product variant',
        description: 'Store owner or ADMIN. Refused when the variant has been ordered.',
        security: [{ bearerAuth: [] }],
        params: variantIdParams,
        response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await deleteVariant(req.authUser!, req.params.productId, req.params.variantId);
      return reply.code(200).send({ ok: true });
    },
  );

  app.get<{ Params: { productId: string } }>(
    '/v1/commerce/products/:productId/inventory',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Get inventory for a product',
        description: 'Store owner or ADMIN. Internal stock counts; never exposed publicly.',
        security: [{ bearerAuth: [] }],
        params: productIdParams,
        response: {
          200: {
            type: 'object',
            required: ['inventory'],
            properties: {
              inventory: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    productId: { type: 'string' },
                    variantId: { type: ['string', 'null'] },
                    quantityAvailable: { type: 'integer' },
                    quantityReserved: { type: 'integer' },
                    quantitySold: { type: 'integer' },
                  },
                },
              },
            },
          },
          ...commerceErrors,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const inventory = await getInventory(req.authUser!, req.params.productId);
      return reply.code(200).send({ inventory });
    },
  );

  app.post<{ Params: { productId: string }; Body: { variantId?: string; quantityAvailable: number } }>(
    '/v1/commerce/products/:productId/inventory',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Set inventory for a product or variant',
        description:
          'Store owner or ADMIN. Sets absolute available quantity; ' +
          'reserved units are never clobbered. Depleting all units flips ' +
          'an ACTIVE product to SOLD_OUT; restocking flips it back.',
        security: [{ bearerAuth: [] }],
        params: productIdParams,
        body: setInventoryBody,
        response: {
          200: {
            type: 'object',
            required: ['inventory'],
            properties: {
              inventory: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    productId: { type: 'string' },
                    variantId: { type: ['string', 'null'] },
                    quantityAvailable: { type: 'integer' },
                    quantityReserved: { type: 'integer' },
                    quantitySold: { type: 'integer' },
                  },
                },
              },
            },
          },
          ...commerceErrors,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(
        req.authUser!.id,
        'commerce.product_create',
        config.rateLimits.commerceProductCreate,
      );
      const inventory = await setInventory(
        req.authUser!,
        req.params.productId,
        req.body.variantId,
        req.body.quantityAvailable,
      );
      return reply.code(200).send({ inventory });
    },
  );

  app.post<{ Params: { productId: string }; Body: { imageUrl: string; altText?: string } }>(
    '/v1/commerce/products/:productId/images',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Add a product image',
        description: 'Store owner or ADMIN. Image references use the existing storage approach (URLs).',
        security: [{ bearerAuth: [] }],
        params: productIdParams,
        body: addProductImageBody,
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              imageUrl: { type: 'string' },
              altText: { type: ['string', 'null'] },
              sortOrder: { type: 'integer' },
            },
          },
          ...commerceErrors,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const image = await addProductImage(
        req.authUser!,
        req.params.productId,
        req.body.imageUrl,
        req.body.altText,
      );
      return reply.code(201).send(image);
    },
  );

  app.post<{ Params: { productId: string }; Body: { imageIds: string[] } }>(
    '/v1/commerce/products/:productId/images/reorder',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Reorder product images',
        description: 'Store owner or ADMIN. imageIds must list exactly the product\u2019s images in the new order.',
        security: [{ bearerAuth: [] }],
        params: productIdParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['imageIds'],
          properties: { imageIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 } },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                imageUrl: { type: 'string' },
                altText: { type: ['string', 'null'] },
                sortOrder: { type: 'integer' },
              },
            },
          },
          ...commerceErrors,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const images = await reorderProductImages(req.authUser!, req.params.productId, req.body.imageIds);
      return reply.code(200).send(images);
    },
  );

  app.delete<{ Params: { imageId: string } }>(
    '/v1/commerce/products/images/:imageId',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Remove a product image',
        description: 'Store owner or ADMIN.',
        security: [{ bearerAuth: [] }],
        params: imageIdParams,
        response: { 204: { type: 'null' }, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await removeProductImage(req.authUser!, req.params.imageId);
      return reply.code(204).send();
    },
  );

  // --------------------------------------------------------------- cart ---

  app.get(
    '/v1/commerce/cart',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Get your cart',
        description: 'Authenticated. The cart belongs to the caller; prices shown are current server prices.',
        security: [{ bearerAuth: [] }],
        response: { 200: cartSchema, 401: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => reply.code(200).send(await getCart(req.authUser!)),
  );

  app.post<{ Body: AddToCartInput }>(
    '/v1/commerce/cart/items',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Add a product to your cart',
        description:
          'Authenticated. Only ACTIVE products on ACTIVE stores; variant ' +
          'required when the product has variants. Per-user rate limited.',
        security: [{ bearerAuth: [] }],
        body: addToCartBody,
        response: { 200: cartSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'commerce.cart_mutate', config.rateLimits.commerceCartMutate);
      return reply.code(200).send(await addToCart(req.authUser!, req.body, config));
    },
  );

  app.patch<{ Params: { itemId: string }; Body: { quantity: number } }>(
    '/v1/commerce/cart/items/:itemId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Update a cart line quantity',
        description: 'Authenticated. Quantity 0 removes the line.',
        security: [{ bearerAuth: [] }],
        params: cartItemIdParams,
        body: updateCartItemBody,
        response: { 200: cartSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'commerce.cart_mutate', config.rateLimits.commerceCartMutate);
      return reply
        .code(200)
        .send(await updateCartItem(req.authUser!, req.params.itemId, req.body.quantity, config));
    },
  );

  app.delete<{ Params: { itemId: string } }>(
    '/v1/commerce/cart/items/:itemId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Remove a cart line',
        description: 'Authenticated.',
        security: [{ bearerAuth: [] }],
        params: cartItemIdParams,
        response: { 200: cartSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'commerce.cart_mutate', config.rateLimits.commerceCartMutate);
      return reply.code(200).send(await removeCartItem(req.authUser!, req.params.itemId));
    },
  );

  app.delete(
    '/v1/commerce/cart',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Clear your cart',
        description: 'Authenticated.',
        security: [{ bearerAuth: [] }],
        response: { 204: { type: 'null' }, 401: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await clearCart(req.authUser!);
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------- orders ---

  app.post<{ Body: CheckoutInput }>(
    '/v1/commerce/checkout',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Check out your cart',
        description:
          'Authenticated. Server-authoritative: re-reads the cart, ' +
          'validates product/store status, recomputes prices server-side ' +
          '(client prices do not exist), atomically reserves inventory, ' +
          'creates the order snapshot and a provider payment intent. ' +
          'One store per order — multi-store carts check out per store. ' +
          'Idempotent per idempotencyKey. Per-user rate limited.',
        security: [{ bearerAuth: [] }],
        body: checkoutBody,
        response: { 200: checkoutResponseSchema, 201: checkoutResponseSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'commerce.checkout', config.rateLimits.commerceCheckout);
      const result = await checkout(req.authUser!, req.body, provider);
      return reply.code(result.created ? 201 : 200).send(result);
    },
  );

  app.post<{ Params: { orderId: string } }>(
    '/v1/commerce/orders/:orderId/confirm-payment',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Confirm payment for an order',
        description:
          'Authenticated. The client signals "payment finished in the ' +
          'provider UI"; the server then VERIFIES with the provider and ' +
          'only verified state moves the order to PAID. A forged ' +
          'callback can never grant PAID.',
        security: [{ bearerAuth: [] }],
        params: orderIdParams,
        response: { 200: orderSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const order = await confirmPayment(req.authUser!, req.params.orderId, provider);
      return reply.code(200).send(order);
    },
  );

  app.post<{ Params: { orderId: string } }>(
    '/v1/commerce/orders/:orderId/retry-payment',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Retry a failed payment',
        description:
          'Authenticated. Mints a fresh provider intent for a ' +
          'PENDING_PAYMENT order whose payment failed; re-reserves ' +
          'inventory atomically.',
        security: [{ bearerAuth: [] }],
        params: orderIdParams,
        response: {
          200: {
            type: 'object',
            required: ['order', 'clientData'],
            properties: { order: orderSchema, clientData: { type: 'object' } },
          },
          ...commerceErrors,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'commerce.checkout', config.rateLimits.commerceCheckout);
      const result = await retryPayment(req.authUser!, req.params.orderId, provider);
      return reply.code(200).send(result);
    },
  );

  app.post<{ Params: { orderId: string } }>(
    '/v1/commerce/orders/:orderId/cancel',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Cancel an unpaid order',
        description:
          'Authenticated. Buyer only; PENDING_PAYMENT orders only. ' +
          'Reserved inventory is released.',
        security: [{ bearerAuth: [] }],
        params: orderIdParams,
        response: { 200: orderSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const order = await cancelOrder(req.authUser!, req.params.orderId);
      return reply.code(200).send(order);
    },
  );

  app.get<{ Querystring: ListOrdersQuery }>(
    '/v1/commerce/orders',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'List your orders',
        description: 'Authenticated. Your order history only.',
        security: [{ bearerAuth: [] }],
        querystring: ordersQuery,
        response: { 200: pageOf(orderSchema), 401: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => reply.code(200).send(await listMyOrders(req.authUser!, req.query)),
  );

  app.get<{ Params: { orderId: string } }>(
    '/v1/commerce/orders/:orderId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Commerce'],
        summary: 'Get an order',
        description:
          'Authenticated. Buyers see their own orders; store owners and ' +
          'ADMIN see their stores\u2019 orders (with fulfillment details).',
        security: [{ bearerAuth: [] }],
        params: orderIdParams,
        response: { 200: orderSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const order = await getOrder(req.authUser!, req.params.orderId);
      return reply.code(200).send(order);
    },
  );

  // ------------------------------------------------- artist order mgmt ---

  app.get<{ Params: { storeId: string }; Querystring: ListOrdersQuery }>(
    '/v1/commerce/stores/:storeId/orders',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: "List a store's orders",
        description:
          'Store owner or ADMIN. Includes buyer name and shipping ' +
          'address for fulfillment. Artist A can never see Artist B\u2019s orders.',
        security: [{ bearerAuth: [] }],
        params: storeIdParams,
        querystring: ordersQuery,
        response: { 200: pageOf(orderSchema), ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const page = await listStoreOrders(req.authUser!, req.params.storeId, req.query);
      return reply.code(200).send(page);
    },
  );

  app.patch<{ Params: { orderId: string }; Body: { status: 'PROCESSING' | 'SHIPPED' | 'DELIVERED' } }>(
    '/v1/commerce/orders/:orderId/fulfillment',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Update order fulfillment',
        description:
          'Store owner or ADMIN. Manual fulfillment transitions ' +
          'PAID → PROCESSING → SHIPPED → DELIVERED (no carrier ' +
          'integration in Phase 30). Payment state is untouched.',
        security: [{ bearerAuth: [] }],
        params: orderIdParams,
        body: fulfillmentBody,
        response: { 200: orderSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const order = await updateFulfillment(req.authUser!, req.params.orderId, req.body.status);
      return reply.code(200).send(order);
    },
  );

  app.post<{ Params: { orderId: string }; Body: { idempotencyKey: string; reason?: string } }>(
    '/v1/commerce/orders/:orderId/refund',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Commerce'],
        summary: 'Refund an order',
        description:
          'Store owner or ADMIN. Full refunds only, through the provider ' +
          'abstraction. Unpaid orders cannot be refunded (cancel them). ' +
          'Idempotent per idempotencyKey. Per-user rate limited.',
        security: [{ bearerAuth: [] }],
        params: orderIdParams,
        body: refundBody,
        response: { 200: refundSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(
        req.authUser!.id,
        'commerce.refund_request',
        config.rateLimits.commerceRefundRequest,
      );
      const refund = await refundOrder(
        req.authUser!,
        req.params.orderId,
        req.body.reason,
        req.body.idempotencyKey,
        provider,
      );
      return reply.code(200).send(refund);
    },
  );

  // ------------------------------------------------------------ webhooks ---

  app.post<{ Params: { providerId: string } }>(
    '/v1/commerce/webhooks/:providerId',
    {
      preParsing: captureRawBody,
      schema: {
        tags: ['Commerce'],
        summary: 'Provider payment webhook',
        description:
          'Unauthenticated (signature-verified). The provider calls this ' +
          'on payment lifecycle events. Signatures are verified through ' +
          'the provider boundary; processing is idempotent per provider ' +
          'event id; unknown payments are acknowledged without effect.',
        params: {
          type: 'object',
          required: ['providerId'],
          additionalProperties: false,
          properties: { providerId: { type: 'string' } },
        },
        response: { 200: webhookResultSchema, 400: problemSchema, 401: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      if (req.params.providerId !== provider.id) {
        throw notFound('Unknown payment provider.');
      }
      const rawBody = (req as { rawBody?: string }).rawBody ?? '';
      const signature =
        (req.headers['x-mock-signature'] as string | undefined) ??
        (req.headers['stripe-signature'] as string | undefined);
      const result = await handleWebhookEvent(provider, rawBody, signature);
      return reply.code(200).send(result);
    },
  );

  // ---------------------------------------------------------------- admin ---

  app.get<{ Querystring: PaginationQuery & { status?: string; q?: string } }>(
    '/v1/admin/commerce/stores',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'List all storefronts',
        description: 'ADMIN-only. All statuses.',
        security: [{ bearerAuth: [] }],
        querystring: storesQuery,
        response: { 200: pageOf(storeSchema), ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const page = await listStoresAdmin(req.query as unknown as ListStoresQuery);
      return reply.code(200).send(page);
    },
  );

  app.post<{ Params: { storeId: string }; Body: { action: 'suspend' | 'reinstate' } }>(
    '/v1/admin/commerce/stores/:storeId/moderate',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Suspend or reinstate a store',
        description:
          'ADMIN-only. Suspended stores vanish from public surfaces and ' +
          'cannot take orders. Audited.',
        security: [{ bearerAuth: [] }],
        params: storeIdParams,
        body: moderateStoreBody,
        response: { 200: storeSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const store = await moderateStore(req.authUser!, req.params.storeId, req.body.action);
      return reply.code(200).send(store);
    },
  );

  app.get<{ Querystring: PaginationQuery & { status?: string; q?: string } }>(
    '/v1/admin/commerce/products',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'List all products',
        description: 'ADMIN-only. All statuses, for moderation.',
        security: [{ bearerAuth: [] }],
        querystring: storesQuery,
        response: { 200: pageOf(productSchema), ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const page = await listProductsAdmin(req.query as unknown as ListProductsAdminQuery);
      return reply.code(200).send(page);
    },
  );

  app.get(
    '/v1/admin/commerce/stats',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Commerce overview stats',
        description: 'ADMIN-only. Aggregate store/product/order/refund counts and gross.',
        security: [{ bearerAuth: [] }],
        response: { 200: commerceStatsSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (_req, reply) => {
      return reply.code(200).send(await getCommerceStats());
    },
  );

  app.post<{ Params: { productId: string }; Body: { action: 'remove' | 'restore' } }>(
    '/v1/admin/commerce/products/:productId/moderate',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Remove or restore a product',
        description:
          'ADMIN-only. Removed products are never purchasable; ' +
          'historical orders keep their snapshots. Audited.',
        security: [{ bearerAuth: [] }],
        params: productIdParams,
        body: moderateProductBody,
        response: { 200: productSchema, ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const product = await moderateProduct(req.authUser!, req.params.productId, req.body.action);
      return reply.code(200).send(product);
    },
  );

  app.get<{ Querystring: ListOrdersQuery }>(
    '/v1/admin/commerce/orders',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'List all commerce orders',
        description: 'ADMIN-only. Includes fulfillment details.',
        security: [{ bearerAuth: [] }],
        querystring: ordersQuery,
        response: { 200: pageOf(orderSchema), ...commerceErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const page = await listOrdersAdmin(req.query);
      return reply.code(200).send(page);
    },
  );

  // ------------------------------------------------------------------ dev ---
  // Deterministic mock-provider controls. Registered always (like the
  // subscription dev endpoints) but unreachable unless the mock provider is
  // configured — which config.ts only permits in development/test.

  const devOnly = (): void => {
    if (provider.id !== 'mock') throw notFound('Not found.');
  };

  app.post<{ Body: { providerPaymentId: string; outcome: 'succeeded' | 'failed' | 'canceled' } }>(
    '/v1/dev/commerce/payment-scenario',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Dev'],
        summary: '[DEV ONLY] Preset mock payment outcome',
        description:
          'Authenticated. Presets what the mock provider will report ' +
          'for an intent. 404 unless the mock provider is configured.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['providerPaymentId', 'outcome'],
          properties: {
            providerPaymentId: { type: 'string' },
            outcome: { type: 'string', enum: ['succeeded', 'failed', 'canceled'] },
          },
        },
        response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      devOnly();
      setMockPaymentScenario(req.body.providerPaymentId, req.body.outcome);
      return reply.code(200).send({ ok: true });
    },
  );

  app.post<{ Body: { providerPaymentId: string } }>(
    '/v1/dev/commerce/complete-payment',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Dev'],
        summary: '[DEV ONLY] Simulate provider-side payment completion',
        description:
          'Authenticated. Simulates the buyer finishing payment in the ' +
          'provider UI. The order still moves only after confirm-payment ' +
          'verifies with the provider. 404 unless mock is configured.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['providerPaymentId'],
          properties: { providerPaymentId: { type: 'string' } },
        },
        response: {
          200: {
            type: 'object',
            properties: { ok: { type: 'boolean' }, status: { type: 'string' } },
          },
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      devOnly();
      const status = completeMockPayment(req.body.providerPaymentId);
      return reply.code(200).send({ ok: true, status });
    },
  );

  app.post<{ Body: { providerPaymentId: string; eventType: NormalizedPaymentEvent['eventType'] } }>(
    '/v1/dev/commerce/payment-webhook',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Dev'],
        summary: '[DEV ONLY] Deliver a signed mock webhook',
        description:
          'Authenticated. Builds a correctly-signed mock webhook payload ' +
          'and processes it through the real webhook handler (signature ' +
          'verification + idempotency). 404 unless mock is configured.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['providerPaymentId', 'eventType'],
          properties: {
            providerPaymentId: { type: 'string' },
            eventType: {
              type: 'string',
              enum: ['payment.succeeded', 'payment.failed', 'payment.canceled', 'payment.refunded'],
            },
          },
        },
        response: { 200: webhookResultSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      devOnly();
      const { body, signature } = buildMockWebhookPayload(
        req.body.providerPaymentId,
        req.body.eventType,
        config.commerce.mockWebhookSecret,
      );
      const result = await handleWebhookEvent(provider, body, signature);
      return reply.code(200).send(result);
    },
  );
}

export { resetCommerceRateLimits };
