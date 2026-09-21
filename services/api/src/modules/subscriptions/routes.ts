// Phase 18 — subscriptions & entitlements. HTTP routes. Thin handlers over
// the subscription service and the entitlement service.
//
// Endpoints:
//   GET  /v1/subscriptions/me               (auth) current subscription + entitlement
//   GET  /v1/subscriptions/me/entitlement    (auth) lightweight entitlement check
//   GET  /v1/admin/users/:id/subscription   (ADMIN) inspect a user's subscription
//   POST /v1/dev/subscription-events        (auth + dev-flag) deterministic events
//
// The dev endpoint is the ONLY writer of subscription state in this phase,
// and it 404s unless DEV_SUBSCRIPTIONS_ENABLED is true (never in production).

import type { FastifyInstance } from 'fastify';
import type { SubscriptionEventType } from '@prisma/client';
import type { Config } from '../../config.js';
import { prisma } from '../../db.js';
import { notFound, problemSchema } from '../../http/errors.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import { getEntitlement, type EntitlementResult } from './entitlements.js';
import {
  applyProviderEvent,
  getCurrentSubscription,
  getSubscriptionHistory,
  type SubscriptionState,
} from './service.js';
import { devProvider, toPrismaProvider } from './providers.js';
import {
  adminSubscriptionDetailSchema,
  devSubscriptionEventBody,
  devSubscriptionEventResultSchema,
  entitlementSchema,
  mySubscriptionSchema,
  userIdParams,
} from './schemas.js';

const readErrors = {
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
};

interface SubscriptionDto extends SubscriptionState {
  plan: { id: string; name: string; planType: string; active: boolean };
}

async function loadPlan(planId: string) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: planId } });
  return { id: plan.id, name: plan.name, planType: plan.planType, active: plan.active };
}

async function toDto(state: SubscriptionState): Promise<SubscriptionDto> {
  return { ...state, plan: await loadPlan(state.planId) };
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

  // --- Admin inspection ---------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/v1/admin/users/:id/subscription',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
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
      return reply.code(200).send({
        subscription: sub ? await toAdminDto(sub) : null,
        entitlement: toEntitlementDto(entitlement),
        events: events.map((e) => ({
          id: e.id,
          eventType: e.eventType,
          statusFrom: e.statusFrom,
          statusTo: e.statusTo,
          createdAt: e.createdAt,
        })),
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
