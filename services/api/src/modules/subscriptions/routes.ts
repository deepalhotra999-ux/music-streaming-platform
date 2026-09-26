// Phase 19 — subscriptions & entitlements. HTTP routes. Thin handlers over
// the subscription service and the entitlement service.
//
// Endpoints:
//   GET  /v1/subscriptions/me               (auth) current subscription + entitlement
//   GET  /v1/subscriptions/me/entitlement    (auth) lightweight entitlement check
//   GET  /v1/subscriptions/products          (auth) store products mapped to plans
//   POST /v1/subscriptions/verify-purchase   (auth) verify a store purchase token
//   POST /v1/subscriptions/notifications/apple   (no auth) App Store Server Notifications v2
//   POST /v1/subscriptions/notifications/google  (no auth) Play RTDN (Pub/Sub push)
//   GET  /v1/admin/users/:id/subscription   (ADMIN) inspect a user's subscription
//   POST /v1/dev/subscription-events        (auth + dev-flag) deterministic events
//
// Security: the notification endpoints authenticate the payload
// server-side (Apple JWS chain / Google shared URL token) before anything
// is normalized. Client purchase callbacks never grant entitlement — only
// a store-verified adapter event mutates subscription state.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { SubscriptionEventType, SubscriptionProvider } from '@prisma/client';
import type { Config } from '../../config.js';
import { prisma } from '../../db.js';
import { notFound, problemSchema, unprocessableEntity } from '../../http/errors.js';
import { requirePermission } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import { getEntitlement, type EntitlementResult } from './entitlements.js';
import {
  applyProviderEvent,
  getCurrentSubscription,
  getSubscriptionHistory,
  type SubscriptionState,
} from './service.js';
import { devProvider, toPrismaProvider } from './providers.js';
import { getStoreAdapter, type StoreProviderId } from './providerContext.js';
import {
  adminSubscriptionDetailSchema,
  appleNotificationBody,
  devSubscriptionEventBody,
  devSubscriptionEventResultSchema,
  entitlementSchema,
  googleNotificationBody,
  mySubscriptionSchema,
  notificationResultSchema,
  storeProductsSchema,
  userIdParams,
  verifyPurchaseBody,
  verifyPurchaseResultSchema,
} from './schemas.js';

const readErrors = {
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
};

interface PlanInfo {
  id: string;
  name: string;
  planType: string;
  active: boolean;
}

interface SubscriptionDto extends SubscriptionState {
  plan: PlanInfo;
  /** Phase 19 — the store product id, resolved from the plan mapping. */
  storeProductId: string | null;
}

async function loadPlan(
  planId: string,
): Promise<PlanInfo & { appleProductId: string | null; googleProductId: string | null }> {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  return {
    id: plan.id,
    name: plan.name,
    planType: plan.planType,
    active: plan.active,
    appleProductId: plan.appleProductId,
    googleProductId: plan.googleProductId,
  };
}

function storeProductIdFor(
  provider: SubscriptionProvider,
  plan: { appleProductId: string | null; googleProductId: string | null },
): string | null {
  if (provider === 'APPLE') return plan.appleProductId;
  if (provider === 'GOOGLE') return plan.googleProductId;
  return null;
}

async function toDto(state: SubscriptionState): Promise<SubscriptionDto> {
  const plan = await loadPlan(state.planId);
  const { appleProductId: _a, googleProductId: _g, ...planInfo } = plan;
  return { ...state, plan: planInfo, storeProductId: storeProductIdFor(state.provider, plan) };
}

/**
 * Phase 18 — current-user DTO: strips externalSubscriptionId (external
 * transaction detail) and userId (implied). Admin keeps userId but not the
 * external store identifier.
 */
async function toPublicDto(state: SubscriptionState) {
  const full = await toDto(state);
  const { externalSubscriptionId: _ext, userId: _uid, ...pub } = full;
  return pub;
}

async function toAdminDto(state: SubscriptionState) {
  const full = await toDto(state);
  const { externalSubscriptionId: _ext, ...admin } = full;
  return admin;
}

function toEntitlementDto(e: EntitlementResult) {
  return {
    entitled: e.entitled,
    status: e.status,
    planCode: e.planCode,
    currentPeriodEnd: e.currentPeriodEnd,
    reason: e.reason,
  };
}

/**
 * Phase 19 — attribute a store server notification to a user. The existing
 * subscription owner's id wins; for first-seen subscriptions the verified
 * appAccountToken (Apple) binds the purchase to the app user that made it.
 * Throws 422 when the notification cannot be attributed to any user.
 */
async function resolveNotificationUserId(
  provider: 'APPLE' | 'GOOGLE',
  event: { externalSubscriptionId: string; appAccountUserId?: string },
): Promise<string> {
  const existing = await prisma.subscription.findUnique({
    where: {
      provider_externalSubscriptionId: {
        provider,
        externalSubscriptionId: event.externalSubscriptionId,
      },
    },
    select: { userId: true },
  });
  if (existing) return existing.userId;
  if (event.appAccountUserId) {
    const user = await prisma.user.findUnique({
      where: { id: event.appAccountUserId },
      select: { id: true },
    });
    if (user) return user.id;
  }
  throw unprocessableEntity(
    'Cannot attribute this notification to a user: unknown subscription ' +
      'and no verified app account token.',
  );
}

export async function subscriptionRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  // --- Current user ------------------------------------------------------

  app.get(
    '/v1/subscriptions/me',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: limit },
      schema: {
        tags: ['Subscriptions'],
        summary: 'Get my subscription',
        description:
          'Authenticated. The caller\u2019s current subscription (plan, status, ' +
          'period dates) plus the server-computed entitlement state. ' +
          'Entitlement is always derived server-side; no client flag is read.',
        security: [{ bearerAuth: [] }],
        response: { 200: mySubscriptionSchema, ...readErrors },
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const sub = await getCurrentSubscription(userId, prisma);
      const entitlement = await getEntitlement(userId, prisma);
      return reply.code(200).send({
        subscription: sub ? await toPublicDto(sub) : null,
        entitlement: toEntitlementDto(entitlement),
      });
    },
  );

  app.get(
    '/v1/subscriptions/me/entitlement',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: limit },
      schema: {
        tags: ['Subscriptions'],
        summary: 'Get my entitlement',
        description:
          'Authenticated. Lightweight server-computed premium-access check. ' +
          'Clients use this to render locked/unlocked UI; playback itself is ' +
          'gated server-side at session creation.',
        security: [{ bearerAuth: [] }],
        response: { 200: entitlementSchema, ...readErrors },
      },
    },
    async (request, reply) => {
      const entitlement = await getEntitlement(request.authUser!.id, prisma);
      return reply.code(200).send(toEntitlementDto(entitlement));
    },
  );

  // --- Phase 19 — store products & purchase verification -----------------

  app.get(
    '/v1/subscriptions/products',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: limit },
      schema: {
        tags: ['Subscriptions'],
        summary: 'List store products',
        description:
          'Authenticated. Purchasable plans with their configured App Store / ' +
          'Google Play product ids. The mapping lives in the plans table — ' +
          'no product ids are hard-coded. A plan is listed only when at ' +
          'least one store product id is configured.',
        security: [{ bearerAuth: [] }],
        response: { 200: storeProductsSchema, ...readErrors },
      },
    },
    async (_request, reply) => {
      const plans = await prisma.plan.findMany({
        where: { active: true },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          name: true,
          planType: true,
          appleProductId: true,
          googleProductId: true,
        },
      });
      const products = plans
        .filter((p) => p.appleProductId || p.googleProductId)
        .map((p) => ({
          planCode: p.id,
          planName: p.name,
          planType: p.planType,
          appleProductId: p.appleProductId,
          googleProductId: p.googleProductId,
        }));
      return reply.code(200).send({
        products,
        appleConfigured: config.subscriptions.apple.enabled,
        googleConfigured: config.subscriptions.google.enabled,
      });
    },
  );

  app.post<{ Body: { provider: StoreProviderId; purchaseToken: string } }>(
    '/v1/subscriptions/verify-purchase',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: limit },
      schema: {
        tags: ['Subscriptions'],
        summary: 'Verify a store purchase',
        description:
          'Authenticated. The mobile app sends raw store transaction ' +
          'evidence (Apple signed-transaction JWS or transaction id; ' +
          'Google Play purchase token). The server verifies it against ' +
          'the store before applying anything. The client callback alone ' +
          'never grants entitlement — only the verified adapter event ' +
          'mutates subscription state.',
        security: [{ bearerAuth: [] }],
        body: verifyPurchaseBody,
        response: {
          200: verifyPurchaseResultSchema,
          201: verifyPurchaseResultSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
          422: problemSchema,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.authUser!.id;
      const adapter = getStoreAdapter(request.body.provider, {
        config: config.subscriptions,
        db: prisma,
      });
      const event = await adapter.verifyPurchase(request.body.purchaseToken);
      // Phase 19 — purchase binding. When the store records which app user
      // made the purchase (Apple appAccountToken, set by our mobile app),
      // the token must belong to the caller; otherwise one user could
      // attach another user's purchase to their own account.
      if (event.appAccountUserId && event.appAccountUserId !== userId) {
        throw unprocessableEntity('This purchase belongs to a different account.');
      }
      const provider = toPrismaProvider(request.body.provider);
      const { state, duplicate } = await applyProviderEvent({ userId, provider, event }, prisma);
      const entitlement = await getEntitlement(userId, prisma);
      return reply.code(duplicate ? 200 : 201).send({
        subscription: await toPublicDto(state),
        entitlement: toEntitlementDto(entitlement),
        duplicate,
      });
    },
  );

  // --- Phase 19 — store server notifications -------------------------------

  app.post<{ Body: { signedPayload: string } }>(
    '/v1/subscriptions/notifications/apple',
    {
      // No authentication: Apple calls this. The signedPayload JWS is
      // verified against Apple's certificate chain inside the adapter
      // before any field is read; unverifiable payloads are rejected.
      config: { rateLimit: limit },
      schema: {
        tags: ['Subscriptions'],
        summary: '[Store] App Store Server Notifications v2',
        description:
          'Apple App Store Server Notifications v2 receiver. The ' +
          'signedPayload JWS is verified against Apple\u2019s certificate ' +
          'chain; malformed payloads are rejected (400), unverifiable ' +
          'ones (422). Notifications with no lifecycle change are ' +
          'acknowledged without touching subscription state.',
        body: appleNotificationBody,
        response: {
          200: notificationResultSchema,
          400: problemSchema,
          404: problemSchema,
          409: problemSchema,
          422: problemSchema,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const adapter = getStoreAdapter('apple', {
        config: config.subscriptions,
        db: prisma,
      });
      const event = await adapter.normalizeServerEvent(request.body);
      if (!event) {
        // Test pings, consumption requests, price-consent notices, …
        return reply.code(200).send({ received: true, ignored: true });
      }
      // Attribute the notification: the subscription owner's id wins;
      // for first-seen subscriptions the verified appAccountToken binds
      // the purchase to the app user that made it.
      const userId = await resolveNotificationUserId('APPLE', event);
      const { state, duplicate } = await applyProviderEvent(
        { userId, provider: 'APPLE', event },
        prisma,
      );
      void state;
      return reply.code(200).send({
        received: true,
        duplicate,
        eventType: event.eventType,
      });
    },
  );

  app.post<{
    Body: { message: { data: string; messageId?: string; publishTime?: string } };
    Querystring: { token?: string };
  }>(
    '/v1/subscriptions/notifications/google',
    {
      // No authentication: Google Pub/Sub calls this. The push is
      // authenticated by the shared verification token in the URL query
      // string (timing-safe comparison); the payload itself is only a
      // hint — the adapter re-fetches authoritative state from the Play API.
      config: { rateLimit: limit },
      schema: {
        tags: ['Subscriptions'],
        summary: '[Store] Google Play Real-time Developer Notifications',
        description:
          'Google Play RTDN (Pub/Sub push) receiver. The push is ' +
          'authenticated by the shared verification token in the ?token= ' +
          'query string. The notification is only a hint: the adapter ' +
          're-fetches the authoritative subscription state from the Play ' +
          'Developer API before normalizing.',
        body: googleNotificationBody,
        response: {
          200: notificationResultSchema,
          400: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
          422: problemSchema,
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const expected = config.subscriptions.google.pubsubVerificationToken;
      if (!config.subscriptions.google.enabled || !expected) {
        // Without a verification token the push cannot be authenticated —
        // fail closed rather than accept unauthenticated pushes.
        throw notFound('The requested resource was not found.');
      }
      const provided = request.query.token ?? '';
      const expectedBuf = Buffer.from(expected, 'utf8');
      const providedBuf = Buffer.from(provided, 'utf8');
      if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
        throw unprocessableEntity('Invalid notification verification token.');
      }
      const adapter = getStoreAdapter('google', {
        config: config.subscriptions,
        db: prisma,
      });
      const event = await adapter.normalizeServerEvent(request.body);
      if (!event) {
        return reply.code(200).send({ received: true, ignored: true });
      }
      // RTDN carries no user identity: it can only update a subscription
      // the client verify-purchase flow already attributed. Unknown
      // subscriptions are rejected — the purchase must be verified via the
      // authenticated client flow first.
      const existing = await prisma.subscription.findUnique({
        where: {
          provider_externalSubscriptionId: {
            provider: 'GOOGLE',
            externalSubscriptionId: event.externalSubscriptionId,
          },
        },
        select: { userId: true },
      });
      if (!existing) {
        throw notFound(
          'Unknown subscription for this notification; verify the purchase ' +
            'via the client flow first.',
        );
      }
      const { duplicate } = await applyProviderEvent(
        { userId: existing.userId, provider: 'GOOGLE', event },
        prisma,
      );
      return reply.code(200).send({
        received: true,
        duplicate,
        eventType: event.eventType,
      });
    },
  );

  // --- Admin inspection ---------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/v1/admin/users/:id/subscription',
    {
      preHandler: [app.authenticate, requirePermission('users.view')],
      config: { rateLimit: limit },
      schema: {
        tags: ['Admin'],
        summary: 'Inspect user subscription',
        description:
          'Admin-only. Read-only inspection of a user\u2019s subscription: ' +
          'status, plan, provider, current period, server-computed entitlement ' +
          'state, and append-only event history. No payment management.',
        security: [{ bearerAuth: [] }],
        params: userIdParams,
        response: { 200: adminSubscriptionDetailSchema, ...readErrors },
      },
    },
    async (request, reply) => {
      const target = await prisma.user.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!target) {
        throw notFound('User not found.');
      }
      const sub = await getCurrentSubscription(target.id, prisma);
      const entitlement = await getEntitlement(target.id, prisma);
      const events = sub ? await getSubscriptionHistory(sub.id, prisma) : [];
      const eventDtos = events.map((e) => ({
        id: e.id,
        eventType: e.eventType,
        statusFrom: e.statusFrom,
        statusTo: e.statusTo,
        createdAt: e.createdAt,
      }));
      return reply.code(200).send({
        subscription: sub ? await toAdminDto(sub) : null,
        entitlement: toEntitlementDto(entitlement),
        events: eventDtos,
        // Phase 19 — the most recent event, for at-a-glance inspection.
        latestEvent: eventDtos.length > 0 ? eventDtos[eventDtos.length - 1] : null,
      });
    },
  );

  // --- Dev-only deterministic event ingestion ------------------------------

  app.post<{
    Body: {
      providerEventId: string;
      eventType: SubscriptionEventType;
      externalSubscriptionId: string;
      planCode?: string;
      periodStart?: string;
      periodEnd?: string;
      facts?: Record<string, string>;
    };
  }>(
    '/v1/dev/subscription-events',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: limit },
      schema: {
        tags: ['Subscriptions'],
        summary: '[DEV ONLY] Apply a subscription event',
        description:
          'Development/test only. Applies a deterministic provider event to ' +
          'the caller\u2019s subscription state with NO store verification. ' +
          'Returns 404 unless DEV_SUBSCRIPTIONS_ENABLED is true (which is ' +
          'rejected in production at startup). Event ingestion is idempotent ' +
          'on (provider, providerEventId).',
        security: [{ bearerAuth: [] }],
        body: devSubscriptionEventBody,
        response: {
          201: devSubscriptionEventResultSchema,
          200: devSubscriptionEventResultSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      if (!config.subscriptions.devEnabled) {
        // Indistinguishable from "no such route": the surface does not
        // exist outside development.
        throw notFound('The requested resource was not found.');
      }
      const userId = request.authUser!.id;
      const event = devProvider.normalizeDevEvent(request.body);
      const { state, duplicate } = await applyProviderEvent(
        { userId, provider: toPrismaProvider('dev'), event },
        prisma,
      );
      const entitlement = await getEntitlement(userId, prisma);
      return reply.code(duplicate ? 200 : 201).send({
        subscription: await toPublicDto(state),
        entitlement: toEntitlementDto(entitlement),
        duplicate,
      });
    },
  );
}
