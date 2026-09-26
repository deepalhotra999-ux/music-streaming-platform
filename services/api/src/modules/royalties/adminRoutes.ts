// Phase 21 — Royalty Engine. Admin HTTP routes.
//
// Write operations (ADMIN only): create/activate policies, create periods,
// record revenue inputs, trigger calculation runs. Inspection is read-only.
// No payout controls, no earnings editing, no entitlement changes.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { apiRateLimit } from '../../http/limits.js';
import { requirePermission } from '../../http/authorization.js';
import { pageOf } from '../../http/pagination.js';
import type { Config } from '../../config.js';
import { runRoyaltyCalculation } from './service.js';
import {
  activatePolicy,
  createPeriod,
  createPolicy,
  createRevenueInput,
  getPeriod,
  getReconciliation,
  getRun,
  getRunArtistTotals,
  getRunTrackTotals,
  listPeriods,
  listPolicies,
  listRuns,
} from './adminService.js';
import {
  activatePolicySchema,
  createPeriodSchema,
  createPolicySchema,
  createRevenueInputSchema,
  paginationQuerySchema,
  reconciliationSchema,
  royaltyPolicySchema,
  royaltyRunSchema,
  runIdParamSchema,
  triggerRunSchema,
} from './schemas.js';

const adminRunItemSchema = {
  ...royaltyRunSchema,
  properties: {
    ...royaltyRunSchema.properties,
    artistCount: { type: 'integer', minimum: 0 },
    trackCount: { type: 'integer', minimum: 0 },
  },
  required: [...royaltyRunSchema.required, 'artistCount', 'trackCount'],
} as const;

const runArtistTotalSchema = {
  type: 'object',
  properties: {
    artistId: { type: 'string', format: 'uuid' },
    artistName: { type: 'string' },
    trackCount: { type: 'integer', minimum: 0 },
    totalStreams: { type: 'integer', minimum: 0 },
    totalEarnings: { type: 'string', pattern: '^-?\\d+\\.\\d{2}$' },
    currency: { type: 'string' },
  },
  required: ['artistId', 'artistName', 'trackCount', 'totalStreams', 'totalEarnings', 'currency'],
  additionalProperties: false,
} as const;

const periodDetailSchema = {
  type: 'object',
  properties: {
    periodId: { type: 'string', format: 'uuid' },
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
    status: { type: 'string' },
    currency: { type: 'string' },
    revenueInputs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          source: { type: 'string' },
          currency: { type: 'string' },
          grossAmount: { type: 'string' },
          deductions: { type: 'string' },
          netAmount: { type: 'string' },
          referenceId: { type: 'string' },
        },
        required: [
          'id',
          'source',
          'currency',
          'grossAmount',
          'deductions',
          'netAmount',
          'referenceId',
        ],
        additionalProperties: false,
      },
    },
    totalNetRevenue: { type: 'string' },
    runs: { type: 'array', items: adminRunItemSchema },
  },
  required: [
    'periodId',
    'periodStart',
    'periodEnd',
    'status',
    'currency',
    'revenueInputs',
    'totalNetRevenue',
    'runs',
  ],
  additionalProperties: false,
} as const;

const runTrackTotalSchema = {
  type: 'object',
  properties: {
    trackId: { type: 'string', format: 'uuid' },
    trackTitle: { type: 'string' },
    artistId: { type: 'string', format: 'uuid' },
    artistName: { type: 'string' },
    eligibleStreams: { type: 'integer', minimum: 0 },
    allocationPercentage: { type: 'string' },
    grossAmount: { type: 'string', pattern: '^-?\\d+\\.\\d{2}$' },
    currency: { type: 'string' },
  },
  required: [
    'trackId',
    'trackTitle',
    'artistId',
    'artistName',
    'eligibleStreams',
    'allocationPercentage',
    'grossAmount',
    'currency',
  ],
  additionalProperties: false,
} as const;

const periodListItemSchema = {
  type: 'object',
  properties: {
    periodId: { type: 'string', format: 'uuid' },
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
    status: { type: 'string' },
    currency: { type: 'string' },
    revenueInputCount: { type: 'integer', minimum: 0 },
    totalNetRevenue: { type: 'string' },
    runCount: { type: 'integer', minimum: 0 },
  },
  required: [
    'periodId',
    'periodStart',
    'periodEnd',
    'status',
    'currency',
    'revenueInputCount',
    'totalNetRevenue',
    'runCount',
  ],
  additionalProperties: false,
} as const;

const triggerRunResponseSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', format: 'uuid' },
    runKey: { type: 'string' },
    status: { type: 'string' },
    duplicate: { type: 'boolean' },
  },
  required: ['runId', 'runKey', 'status', 'duplicate'],
  additionalProperties: false,
} as const;

export async function royaltyAdminRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);
  const deps = { db: prisma };
  const guard = [app.authenticate, requirePermission('royalties.manage')] as const;
  const q = (req: { query?: unknown }) => (req.query ?? {}) as { page?: string; limit?: string };

  // --- Policies ---
  app.post(
    '/v1/admin/royalties/policies',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Create a new royalty policy version (DRAFT)',
        body: createPolicySchema,
        response: { 201: royaltyPolicySchema },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        name: string;
        artistPoolPercentage: string;
        minimumStreams?: number | null;
        currency: string;
        effectiveFrom: string;
      };
      const policy = await createPolicy(
        {
          name: b.name,
          artistPoolPercentage: b.artistPoolPercentage,
          minimumStreams: b.minimumStreams ?? null,
          currency: b.currency,
          effectiveFrom: b.effectiveFrom,
          actorId: req.authUser!.id,
        },
        deps,
      );
      return reply.code(201).send(policy);
    },
  );

  app.get(
    '/v1/admin/royalties/policies',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'List royalty policy versions',
        querystring: paginationQuerySchema,
        response: { 200: pageOf(royaltyPolicySchema) },
      },
    },
    async (req) => listPolicies(q(req), deps),
  );

  app.post(
    '/v1/admin/royalties/policies/:id/activate',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Activate a DRAFT policy (retires the current ACTIVE one)',
        params: runIdParamSchema,
        body: activatePolicySchema,
        response: { 200: royaltyPolicySchema },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return activatePolicy(id, deps);
    },
  );

  // --- Periods ---
  app.post(
    '/v1/admin/royalties/periods',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Create a royalty calculation period',
        body: createPeriodSchema,
        response: { 201: periodDetailSchema },
      },
    },
    async (req, reply) => {
      const b = req.body as { periodStart: string; periodEnd: string; currency?: string };
      const created = await createPeriod(
        {
          periodStart: b.periodStart,
          periodEnd: b.periodEnd,
          currency: b.currency,
          actorId: req.authUser!.id,
        },
        deps,
      );
      const detail = await getPeriod(created.periodId, deps);
      return reply.code(201).send(detail);
    },
  );

  app.get(
    '/v1/admin/royalties/periods/:id',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Royalty period detail with revenue inputs and runs',
        params: runIdParamSchema,
        response: { 200: periodDetailSchema },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getPeriod(id, deps);
    },
  );

  app.get(
    '/v1/admin/royalties/periods',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'List royalty periods with revenue and run summaries',
        querystring: paginationQuerySchema,
        response: { 200: pageOf(periodListItemSchema) },
      },
    },
    async (req) => listPeriods(q(req), deps),
  );

  // --- Revenue inputs ---
  app.post(
    '/v1/admin/royalties/revenue',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Record a verified revenue input for a period',
        body: createRevenueInputSchema,
        response: {
          201: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              periodId: { type: 'string', format: 'uuid' },
              source: { type: 'string' },
              currency: { type: 'string' },
              grossAmount: { type: 'string' },
              deductions: { type: 'string' },
              netAmount: { type: 'string' },
              referenceId: { type: 'string' },
            },
            required: [
              'id',
              'periodId',
              'source',
              'currency',
              'grossAmount',
              'deductions',
              'netAmount',
              'referenceId',
            ],
            additionalProperties: false,
          },
        },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        periodId: string;
        source: string;
        currency: string;
        grossAmount: string;
        deductions?: string;
        referenceId: string;
        fxReference?: string | null;
      };
      const row = await createRevenueInput(
        {
          periodId: b.periodId,
          source: b.source,
          currency: b.currency,
          grossAmount: b.grossAmount,
          deductions: b.deductions,
          referenceId: b.referenceId,
          fxReference: b.fxReference ?? null,
          actorId: req.authUser!.id,
        },
        deps,
      );
      return reply.code(201).send(row);
    },
  );

  // --- Runs ---
  app.post(
    '/v1/admin/royalties/runs',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Trigger a royalty calculation run (idempotent)',
        body: triggerRunSchema,
        response: { 200: triggerRunResponseSchema },
      },
    },
    async (req) => {
      const b = req.body as { periodId: string };
      return runRoyaltyCalculation(b.periodId, req.authUser!.id, deps);
    },
  );

  app.get(
    '/v1/admin/royalties/runs',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'List royalty calculation runs',
        querystring: paginationQuerySchema,
        response: { 200: pageOf(adminRunItemSchema) },
      },
    },
    async (req) => listRuns(q(req), deps),
  );

  app.get(
    '/v1/admin/royalties/runs/:id',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Royalty calculation run detail',
        params: runIdParamSchema,
        response: { 200: adminRunItemSchema },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getRun(id, deps);
    },
  );

  app.get(
    '/v1/admin/royalties/runs/:id/artists',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Artist-level earnings totals for a run',
        params: runIdParamSchema,
        querystring: paginationQuerySchema,
        response: { 200: pageOf(runArtistTotalSchema) },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getRunArtistTotals(id, q(req), deps);
    },
  );

  app.get(
    '/v1/admin/royalties/runs/:id/tracks',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Track-level earnings totals for a run',
        params: runIdParamSchema,
        querystring: paginationQuerySchema,
        response: { 200: pageOf(runTrackTotalSchema) },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getRunTrackTotals(id, q(req), deps);
    },
  );

  app.get(
    '/v1/admin/royalties/runs/:id/reconciliation',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties (admin)'],
        summary: 'Read-only reconciliation: pool = allocations + residual',
        params: runIdParamSchema,
        response: { 200: reconciliationSchema },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getReconciliation(id, deps);
    },
  );
}
