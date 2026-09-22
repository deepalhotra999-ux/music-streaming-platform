// Phase 21 — Royalty Engine. Artist-facing HTTP routes.
//
//   GET /v1/artists/:id/royalties/overview        lifetime totals + latest period
//   GET /v1/artists/:id/royalties/periods         paginated periods w/ earnings
//   GET /v1/artists/:id/royalties/periods/:periodId/tracks  per-track earnings
//   GET /v1/artists/:id/royalties/runs/:runId     calculation run detail
//
// ARTIST or ADMIN role + ownership (canManageArtist). LISTENER -> 403.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { apiRateLimit } from '../../http/limits.js';
import { requireRole } from '../../http/authorization.js';
import { pageOf } from '../../http/pagination.js';
import type { Config } from '../../config.js';
import {
  getRoyaltyOverview,
  getRoyaltyPeriods,
  getRoyaltyPeriodTracks,
  getRoyaltyRun,
} from './artistService.js';
import {
  artistIdParamSchema,
  artistRoyaltyRunSchema,
  paginationQuerySchema,
  periodIdParamSchema,
  royaltyOverviewSchema,
  royaltyPeriodItemSchema,
  royaltyTrackEarningSchema,
  runIdParamSchema,
} from './schemas.js';

export async function royaltyArtistRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);
  const deps = { db: prisma };
  const guard = [app.authenticate, requireRole('ARTIST', 'ADMIN')] as const;

  app.get(
    '/v1/artists/:id/royalties/overview',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties'],
        summary: 'Royalty earnings overview for an owned artist',
        params: artistIdParamSchema,
        response: { 200: royaltyOverviewSchema },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getRoyaltyOverview(id, req.authUser!, deps);
    },
  );

  app.get(
    '/v1/artists/:id/royalties/periods',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties'],
        summary: 'Royalty periods with per-period earnings for an owned artist',
        params: artistIdParamSchema,
        querystring: paginationQuerySchema,
        response: { 200: pageOf(royaltyPeriodItemSchema) },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getRoyaltyPeriods(
        id,
        req.authUser!,
        (req.query ?? {}) as { page?: string; limit?: string },
        deps,
      );
    },
  );

  app.get(
    '/v1/artists/:id/royalties/periods/:periodId/tracks',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties'],
        summary: 'Per-track royalty earnings for an owned artist in a period',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            periodId: { type: 'string', format: 'uuid' },
          },
          required: ['id', 'periodId'],
          additionalProperties: false,
        },
        querystring: paginationQuerySchema,
        response: { 200: pageOf(royaltyTrackEarningSchema) },
      },
    },
    async (req) => {
      const { id, periodId } = req.params as { id: string; periodId: string };
      return getRoyaltyPeriodTracks(
        id,
        periodId,
        req.authUser!,
        (req.query ?? {}) as { page?: string; limit?: string },
        deps,
      );
    },
  );

  app.get(
    '/v1/artists/:id/royalties/runs/:runId',
    {
      preHandler: [...guard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Royalties'],
        summary: 'Royalty calculation run detail (artist must have earnings in it)',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            runId: { type: 'string', format: 'uuid' },
          },
          required: ['id', 'runId'],
          additionalProperties: false,
        },
        response: { 200: artistRoyaltyRunSchema },
      },
    },
    async (req) => {
      const { id, runId } = req.params as { id: string; runId: string };
      return getRoyaltyRun(id, runId, req.authUser!, deps);
    },
  );

  // Re-export param schemas to satisfy unused-import lint if tree-shaken.
  void periodIdParamSchema;
  void runIdParamSchema;
}
