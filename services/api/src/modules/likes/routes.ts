// Phase 4 — likes. HTTP routes. All endpoints require authentication and
// operate on the caller's own likes. Liking is idempotent (201 new, 200
// already liked); unliking always returns 204.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, paginationQuerySchema, type PaginationQuery } from '../../http/pagination.js';
import { apiRateLimit } from '../../http/limits.js';
import { likeBody, likeItemSchema, trackIdParams } from './schemas.js';
import { likeTrack, listLikes, unlikeTrack } from './service.js';

interface TrackIdParams {
  trackId: string;
}

export async function likesRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: PaginationQuery }>(
    '/v1/me/likes',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Likes'],
        summary: 'List my liked tracks',
        description: "Paginated list of the caller's liked tracks, newest first.",
        security: [{ bearerAuth: [] }],
        querystring: paginationQuerySchema,
        response: {
          200: pageOf(likeItemSchema),
          400: problemSchema,
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listLikes(req.authUser!.id, req.query));
    },
  );

  app.post<{ Body: { trackId: string } }>(
    '/v1/me/likes',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Likes'],
        summary: 'Like a track',
        description:
          'Likes a track for the caller. Idempotent: returns 201 when newly liked, ' +
          '200 when it was already liked.',
        security: [{ bearerAuth: [] }],
        body: likeBody,
        response: {
          200: likeItemSchema,
          201: likeItemSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const { created, item } = await likeTrack(req.authUser!.id, req.body.trackId);
      return reply.code(created ? 201 : 200).send(item);
    },
  );

  app.delete<{ Params: TrackIdParams }>(
    '/v1/me/likes/:trackId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Likes'],
        summary: 'Unlike a track',
        description: "Removes the caller's like. Idempotent: always 204.",
        security: [{ bearerAuth: [] }],
        params: trackIdParams,
        response: {
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await unlikeTrack(req.authUser!.id, req.params.trackId);
      return reply.code(204).send();
    },
  );
}
