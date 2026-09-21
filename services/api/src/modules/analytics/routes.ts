// Phase 15 — artist analytics & reporting. HTTP routes.
//
//   GET /v1/artists/:id/analytics/overview   headline totals
//   GET /v1/artists/:id/analytics/tracks     per-track performance (paginated)
//   GET /v1/artists/:id/analytics/albums     per-album performance (paginated)
//   GET /v1/artists/:id/analytics/trend      daily/weekly buckets
//   GET /v1/artists/:id/analytics/recent     latest completed streams
//   GET /v1/analytics/platform/overview     platform-wide (ADMIN only)
//
// Artist-scoped endpoints require ARTIST or ADMIN plus ownership of the
// artist row (the service re-checks with canManageArtist). LISTENER
// callers get 403 from the role guard before any data is touched.

import type { FastifyInstance } from 'fastify';
import { prisma } from '../../db.js';
import { apiRateLimit } from '../../http/limits.js';
import { requireRole } from '../../http/authorization.js';
import { pageOf } from '../../http/pagination.js';
import type { Config } from '../../config.js';
import {
  getArtistAlbumStats,
  getArtistOverview,
  getArtistRecentActivity,
  getArtistTrackStats,
  getArtistTrend,
  getPlatformOverview,
  type AnalyticsRange,
  type TrendGranularity,
} from './service.js';
import {
  albumStatsItemSchema,
  analyticsPagedQuerySchema,
  analyticsRangeQuerySchema,
  analyticsRecentQuerySchema,
  analyticsTrendQuerySchema,
  artistIdParamSchema,
  overviewSchema,
  recentSchema,
  trackStatsItemSchema,
  trendSchema,
} from './schemas.js';

interface RangeQuery {
  range?: AnalyticsRange;
  trackId?: string;
  albumId?: string;
}

const withDefaults = <T extends RangeQuery>(q: T): Required<Pick<T, 'range'>> & T =>
  ({ range: '7d', ...q }) as Required<Pick<T, 'range'>> & T;

export async function analyticsRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);
  const deps = { db: prisma };
  const artistGuard = [app.authenticate, requireRole('ARTIST', 'ADMIN')] as const;

  app.get(
    '/v1/artists/:id/analytics/overview',
    {
      preHandler: [...artistGuard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Analytics'],
        summary: 'Headline analytics totals for an owned artist',
        params: artistIdParamSchema,
        querystring: analyticsRangeQuerySchema,
        response: { 200: overviewSchema },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getArtistOverview(id, req.authUser!, withDefaults(req.query as RangeQuery), deps);
    },
  );

  app.get(
    '/v1/artists/:id/analytics/tracks',
    {
      preHandler: [...artistGuard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Analytics'],
        summary: 'Per-track performance for an owned artist, ranked by streams',
        params: artistIdParamSchema,
        querystring: analyticsPagedQuerySchema,
        response: { 200: pageOf(trackStatsItemSchema) },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getArtistTrackStats(
        id,
        req.authUser!,
        withDefaults(req.query as RangeQuery & { page?: string; limit?: string }),
        deps,
      );
    },
  );

  app.get(
    '/v1/artists/:id/analytics/albums',
    {
      preHandler: [...artistGuard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Analytics'],
        summary: 'Per-album performance for an owned artist, ranked by streams',
        params: artistIdParamSchema,
        querystring: analyticsPagedQuerySchema,
        response: { 200: pageOf(albumStatsItemSchema) },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getArtistAlbumStats(
        id,
        req.authUser!,
        withDefaults(req.query as RangeQuery & { page?: string; limit?: string }),
        deps,
      );
    },
  );

  app.get(
    '/v1/artists/:id/analytics/trend',
    {
      preHandler: [...artistGuard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Analytics'],
        summary: 'Daily or weekly analytics buckets for an owned artist',
        params: artistIdParamSchema,
        querystring: analyticsTrendQuerySchema,
        response: { 200: trendSchema },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const q = withDefaults(req.query as RangeQuery & { granularity?: TrendGranularity });
      return getArtistTrend(id, req.authUser!, { ...q, granularity: q.granularity ?? 'day' }, deps);
    },
  );

  app.get(
    '/v1/artists/:id/analytics/recent',
    {
      preHandler: [...artistGuard],
      config: { rateLimit: limit },
      schema: {
        tags: ['Analytics'],
        summary: 'Latest completed streams for an owned artist (no listener identity)',
        params: artistIdParamSchema,
        querystring: analyticsRecentQuerySchema,
        response: { 200: recentSchema },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return {
        data: await getArtistRecentActivity(
          id,
          req.authUser!,
          withDefaults(req.query as RangeQuery & { limit?: string }),
          deps,
        ),
      };
    },
  );

  app.get(
    '/v1/analytics/platform/overview',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      config: { rateLimit: limit },
      schema: {
        tags: ['Analytics'],
        summary: 'Platform-wide analytics overview (admin only)',
        querystring: analyticsRangeQuerySchema,
        response: { 200: overviewSchema },
      },
    },
    async (req) => {
      const q = withDefaults(req.query as RangeQuery);
      return getPlatformOverview({ range: q.range }, deps);
    },
  );
}
