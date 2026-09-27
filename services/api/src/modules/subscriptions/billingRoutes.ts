// Billing management — admin HTTP routes. Thin handlers over billing.ts.
//
// Endpoints (all require the `subscriptions.manage` permission, held by
// FINANCE_ADMIN and SUPPORT_ADMIN):
//   GET    /v1/admin/billing/plans
//   POST   /v1/admin/billing/plans
//   PATCH  /v1/admin/billing/plans/:id
//   POST   /v1/admin/billing/plans/:id/activate
//   POST   /v1/admin/billing/plans/:id/deactivate
//   GET    /v1/admin/billing/promos
//   POST   /v1/admin/billing/promos
//   POST   /v1/admin/billing/promos/validate        (preview, no consumption)
//   POST   /v1/admin/billing/promos/:id/activate
//   POST   /v1/admin/billing/promos/:id/deactivate
//   DELETE /v1/admin/billing/promos/:id             (only when never redeemed)
//
// The purchase kill switch and grace period are platform settings
// (billing.subscriptions_enabled, billing.grace_period_days), changed via
// the existing SUPER_ADMIN-only settings endpoint.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { problemSchema } from '../../http/errors.js';
import { requirePermission } from '../../http/authorization.js';
import {
  createPlan,
  createPromoCode,
  deletePromoCode,
  listPlans,
  listPromoCodes,
  setPlanActive,
  setPromoActive,
  updatePlan,
  validatePromoCode,
  type PlanInput,
  type PromoInput,
} from './billing.js';

const manageErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
};

const planSchema = {
  type: 'object',
  required: ['id', 'name', 'planType', 'active'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    planType: { type: 'string' },
    active: { type: 'boolean' },
    priceCents: { type: 'integer' },
    currency: { type: 'string' },
    billingInterval: { type: 'string' },
    intervalCount: { type: 'integer' },
    trialDays: { type: 'integer' },
    features: { type: 'array', items: { type: 'string' } },
    sortOrder: { type: 'integer' },
    appleProductId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    googleProductId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    devProductId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    payingSubscribers: { type: 'integer' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const planInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'planType', 'priceCents', 'currency', 'billingInterval'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    planType: { type: 'string', enum: ['INDIVIDUAL', 'FAMILY', 'STUDENT'] },
    priceCents: { type: 'integer', minimum: 0 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    billingInterval: { type: 'string', enum: ['WEEK', 'MONTH', 'YEAR'] },
    intervalCount: { type: 'integer', minimum: 1, maximum: 52 },
    trialDays: { type: 'integer', minimum: 0, maximum: 365 },
    features: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 50 },
    sortOrder: { type: 'integer', minimum: 0 },
    appleProductId: { anyOf: [{ type: 'string', maxLength: 255 }, { type: 'null' }] },
    googleProductId: { anyOf: [{ type: 'string', maxLength: 255 }, { type: 'null' }] },
    devProductId: { anyOf: [{ type: 'string', maxLength: 255 }, { type: 'null' }] },
  },
} as const;

const promoSchema = {
  type: 'object',
  required: ['id', 'code', 'active'],
  properties: {
    id: { type: 'string' },
    code: { type: 'string' },
    description: { type: 'string' },
    percentOff: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    amountOffCents: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    currency: { type: 'string' },
    maxRedemptions: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    redeemedCount: { type: 'integer' },
    startsAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    expiresAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    active: { type: 'boolean' },
    applicablePlans: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const;

const promoInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: {
    code: { type: 'string', minLength: 3, maxLength: 32 },
    description: { type: 'string', maxLength: 500 },
    percentOff: { type: 'integer', minimum: 1, maximum: 100 },
    amountOffCents: { type: 'integer', minimum: 1 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    maxRedemptions: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    startsAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    expiresAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
    applicablePlans: { type: 'array', items: { type: 'string' } },
  },
} as const;

function actorOf(req: {
  authUser: { id: string; impersonation?: { adminId: string; reason: string } | null } | null;
}) {
  return { id: req.authUser!.id, impersonation: req.authUser!.impersonation ?? null };
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  const guard = [app.authenticate, requirePermission('subscriptions.manage')];

  // ------------------------------------------------------------------ plans
  app.get(
    '/v1/admin/billing/plans',
    {
      preHandler: guard,
      schema: {
        tags: ['Admin billing'],
        summary: 'List all plans with pricing',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'array', items: planSchema } as const, ...manageErrors },
      },
    },
    async () => listPlans(prisma),
  );

  app.post<{ Body: PlanInput & { id: string } }>(
    '/v1/admin/billing/plans',
    {
      preHandler: guard,
      schema: {
        tags: ['Admin billing'],
        summary: 'Create a plan',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['id', ...planInputSchema.required],
          properties: {
            id: { type: 'string', minLength: 2, maxLength: 64 },
            ...planInputSchema.properties,
          },
        } as const,
        response: { 201: planSchema, ...manageErrors },
      },
    },
    async (req, reply) => {
      const { id, ...input } = req.body;
      const plan = await createPlan(prisma, actorOf(req), id, input as PlanInput);
      return reply.code(201).send(plan);
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<PlanInput> }>(
    '/v1/admin/billing/plans/:id',
    {
      preHandler: guard,
      schema: {
        tags: ['Admin billing'],
        summary: 'Update a plan',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        } as const,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: planInputSchema.properties,
        } as const,
        response: { 200: planSchema, ...manageErrors },
      },
    },
    async (req) => updatePlan(prisma, actorOf(req), req.params.id, req.body),
  );

  for (const action of ['activate', 'deactivate'] as const) {
    app.post<{ Params: { id: string } }>(
      `/v1/admin/billing/plans/:id/${action}`,
      {
        preHandler: guard,
        schema: {
          tags: ['Admin billing'],
          summary: `${action === 'activate' ? 'Activate' : 'Deactivate'} a plan`,
          description:
            action === 'deactivate'
              ? 'Deactivation is refused while paying subscribers remain on the plan.'
              : undefined,
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
          } as const,
          response: { 200: planSchema, ...manageErrors },
        },
      },
      async (req) => setPlanActive(prisma, actorOf(req), req.params.id, action === 'activate'),
    );
  }

  // ------------------------------------------------------------------ promos
  app.get(
    '/v1/admin/billing/promos',
    {
      preHandler: guard,
      schema: {
        tags: ['Admin billing'],
        summary: 'List promo codes',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'array', items: promoSchema } as const, ...manageErrors },
      },
    },
    async () => listPromoCodes(prisma),
  );

  app.post<{ Body: PromoInput }>(
    '/v1/admin/billing/promos',
    {
      preHandler: guard,
      schema: {
        tags: ['Admin billing'],
        summary: 'Create a promo code',
        security: [{ bearerAuth: [] }],
        body: promoInputSchema,
        response: { 201: promoSchema, ...manageErrors },
      },
    },
    async (req, reply) => {
      const promo = await createPromoCode(prisma, actorOf(req), req.body);
      return reply.code(201).send(promo);
    },
  );

  app.post<{ Body: { code: string; userId: string; planId?: string } }>(
    '/v1/admin/billing/promos/validate',
    {
      preHandler: guard,
      schema: {
        tags: ['Admin billing'],
        summary: 'Validate a promo code without consuming it',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'userId'],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 32 },
            userId: { type: 'string', format: 'uuid' },
            planId: { type: 'string', minLength: 1, maxLength: 64 },
          },
        } as const,
        response: {
          200: {
            type: 'object',
            required: ['valid'],
            properties: {
              valid: { type: 'boolean' },
              reason: { type: 'string' },
              promo: promoSchema,
            },
          } as const,
          ...manageErrors,
        },
      },
    },
    async (req) => validatePromoCode(prisma, req.body.code, req.body.userId, req.body.planId),
  );

  for (const action of ['activate', 'deactivate'] as const) {
    app.post<{ Params: { id: string } }>(
      `/v1/admin/billing/promos/:id/${action}`,
      {
        preHandler: guard,
        schema: {
          tags: ['Admin billing'],
          summary: `${action === 'activate' ? 'Activate' : 'Deactivate'} a promo code`,
          security: [{ bearerAuth: [] }],
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          } as const,
          response: { 200: promoSchema, ...manageErrors },
        },
      },
      async (req) => setPromoActive(prisma, actorOf(req), req.params.id, action === 'activate'),
    );
  }

  app.delete<{ Params: { id: string } }>(
    '/v1/admin/billing/promos/:id',
    {
      preHandler: guard,
      schema: {
        tags: ['Admin billing'],
        summary: 'Delete a promo code',
        description: 'Only allowed when the code was never redeemed.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        } as const,
        response: { 204: { type: 'null' }, ...manageErrors },
      },
    },
    async (req, reply) => {
      await deletePromoCode(prisma, actorOf(req), req.params.id);
      return reply.code(204).send(null);
    },
  );
}
