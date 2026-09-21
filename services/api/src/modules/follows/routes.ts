// Phase 4 — follows. HTTP routes. All endpoints require authentication and
// operate on the caller's own follows. Following is idempotent (201 new,
// 200 already followed); unfollowing always returns 204.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, paginationQuerySchema, type PaginationQuery } from '../../http/pagination.js';
import { apiRateLimit } from '../../http/limits.js';
import { artistIdParams, followBody, followItemSchema } from './schemas.js';
import { followArtist, listFollows, unfollowArtist } from './service.js';

interface ArtistIdParams {
  artistId: string;
}

export async function followsRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: PaginationQuery }>(
    '/v1/me/follows',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Follows'],
        summary: 'List my followed artists',
        description: "Paginated list of the caller's followed artists, newest first.",
        security: [{ bearerAuth: [] }],
        querystring: paginationQuerySchema,
        response: {
          200: pageOf(followItemSchema),
          400: problemSchema,
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listFollows(req.authUser!.id, req.query));
    },
  );

  app.post<{ Body: { artistId: string } }>(
    '/v1/me/follows',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Follows'],
        summary: 'Follow an artist',
        description:
          'Follows an artist for the caller. Idempotent: returns 201 when newly followed, ' +
          '200 when it was already followed.',
        security: [{ bearerAuth: [] }],
        body: followBody,
        response: {
          200: followItemSchema,
          201: followItemSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const { created, item } = await followArtist(req.authUser!.id, req.body.artistId);
      return reply.code(created ? 201 : 200).send(item);
    },
  );

  app.delete<{ Params: ArtistIdParams }>(
    '/v1/me/follows/:artistId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Follows'],
        summary: 'Unfollow an artist',
        description: "Removes the caller's follow. Idempotent: always 204.",
        security: [{ bearerAuth: [] }],
        params: artistIdParams,
        response: {
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await unfollowArtist(req.authUser!.id, req.params.artistId);
      return reply.code(204).send();
    },
  );
}
