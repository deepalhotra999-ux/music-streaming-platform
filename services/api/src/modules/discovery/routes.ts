// Phase 26 — discovery HTTP routes. Thin handlers over the discovery service.
//
// Endpoints (all authenticated):
//   GET  /v1/discovery/recommendations   deterministic recommendations
//   POST /v1/discovery/query             natural-language discovery (AI path)
//   GET  /v1/discovery/emerging          emerging-artist spotlight
//   POST /v1/discovery/playlist-criteria AI-assisted playlist criteria;
//                                        returns criteria + candidate tracks,
//                                        does NOT create a playlist
//
// Conventions: RFC 7807 errors, existing rate-limit helpers, app.authenticate.
// NL queries use a dedicated tight rate-limit bucket (cost control).

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { prisma } from '../../db.js';
import { problemSchema } from '../../http/errors.js';
import { apiRateLimit } from '../../http/limits.js';
import { emergingSpotlight, recommend, type DiscoveryDeps } from './service.js';
import type { DiscoveryConstraints } from './types.js';
import { DiscoveryCache } from './cache.js';
import { createAIProvider } from './ai.js';
import {
  discoveryQueryBodySchema,
  emergingArtistsResponseSchema,
  playlistCriteriaBodySchema,
  playlistCriteriaResponseSchema,
  recommendationResponseSchema,
  recommendationsQuerySchema,
} from './schemas.js';

interface RecommendationsQuery {
  limit?: number;
  genreId?: string;
  artistId?: string;
  emergingOnly?: boolean;
  refresh?: boolean;
}

interface DiscoveryQueryBody {
  query: string;
  limit?: number;
}

interface PlaylistCriteriaBody {
  query: string;
  limit?: number;
  name?: string;
}

/**
 * Build request deps from the typed config. Rate limits, cache TTL, and AI
 * provider/timeout come from Config; only the API key and model name stay
 * env-only (secrets are never added to the typed config).
 */
function deps(config: Config): DiscoveryDeps {
  return {
    db: prisma,
    cache: new DiscoveryCache(config.discovery.cacheTtlMs),
    aiProvider: createAIProvider(prisma, {
      provider: config.discovery.aiProvider,
      apiKey: process.env.DISCOVERY_AI_API_KEY,
      model: process.env.DISCOVERY_AI_MODEL,
      timeoutMs: config.discovery.aiTimeoutMs,
    }),
  };
}

export async function discoveryRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const requestDeps = deps(config);
  // GET /v1/discovery/recommendations — deterministic recommendations.
  app.get<{ Querystring: RecommendationsQuery }>(
    '/v1/discovery/recommendations',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: apiRateLimit(config) },
      schema: {
        querystring: recommendationsQuerySchema,
        response: {
          200: recommendationResponseSchema,
          400: problemSchema,
          401: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request) => {
      const q = request.query;
      const response = await recommend(requestDeps, request.authUser!.id, {
        constraints: {
          limit: q.limit,
          genreIds: q.genreId ? [q.genreId] : [],
          artistIds: q.artistId ? [q.artistId] : [],
          emergingOnly: q.emergingOnly ?? false,
        },
        noCache: q.refresh ?? false,
      });
      return response;
    },
  );

  // POST /v1/discovery/query — natural-language discovery.
  app.post<{ Body: DiscoveryQueryBody }>(
    '/v1/discovery/query',
    {
      preHandler: [app.authenticate],
      // Tight bucket: each call may invoke an AI provider.
      config: {
        rateLimit: {
          max: config.discovery.queryRateLimit,
          timeWindow: config.discovery.queryRateLimitWindowMs,
        },
      },
      schema: {
        body: discoveryQueryBodySchema,
        response: {
          200: recommendationResponseSchema,
          400: problemSchema,
          401: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request) => {
      const body = request.body;
      const response = await recommend(requestDeps, request.authUser!.id, {
        query: body.query,
        constraints: { limit: body.limit },
      });
      return response;
    },
  );

  // GET /v1/discovery/emerging — emerging-artist spotlight.
  app.get(
    '/v1/discovery/emerging',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: apiRateLimit(config) },
      schema: {
        response: {
          200: emergingArtistsResponseSchema,
          401: problemSchema,
          429: problemSchema,
        },
      },
    },
    async () => {
      const artists = await emergingSpotlight(requestDeps, 10);
      return { artists };
    },
  );

  // POST /v1/discovery/playlist-criteria — AI-assisted playlist criteria.
  // Returns structured criteria + candidate tracks. Does NOT create a
  // playlist; the client creates one explicitly via the existing playlist
  // API only after user confirmation.
  app.post<{ Body: PlaylistCriteriaBody }>(
    '/v1/discovery/playlist-criteria',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          max: config.discovery.queryRateLimit,
          timeWindow: config.discovery.queryRateLimitWindowMs,
        },
      },
      schema: {
        body: playlistCriteriaBodySchema,
        response: {
          200: playlistCriteriaResponseSchema,
          400: problemSchema,
          401: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request) => {
      const body = request.body;
      let criteria: DiscoveryConstraints | null = null;
      const response = await recommend(requestDeps, request.authUser!.id, {
        query: body.query,
        constraints: { limit: body.limit ?? 25 },
        onConstraints: (c) => {
          criteria = c;
        },
      });
      // Report the actual validated + catalog-resolved criteria so the
      // client shows what the AI understood before the user confirms
      // playlist creation.
      return {
        requestId: response.requestId,
        criteria: criteria ?? {
          genreIds: [],
          moods: [],
          energy: null,
          tempoBpm: null,
          era: null,
          artistIds: [],
          emergingOnly: false,
          limit: body.limit ?? 25,
          exploration: 0.5,
        },
        items: response.items.map((item) => ({
          track: item.track,
          reason: item.reason,
          reasonKind: item.reasonKind,
        })),
        aiProvider: response.policy.aiProvider,
      };
    },
  );
}
