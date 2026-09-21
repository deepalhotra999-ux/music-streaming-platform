// Phase 4 — listening history. HTTP routes. All endpoints require
// authentication and operate on the caller's own history.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, paginationQuerySchema, type PaginationQuery } from '../../http/pagination.js';
import { apiRateLimit } from '../../http/limits.js';
import { historyItemSchema, recordHistoryBody } from './schemas.js';
import { clearHistory, listHistory, recordPlay, type RecordPlayInput } from './service.js';

export async function historyRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: PaginationQuery }>(
    '/v1/me/history',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['History'],
        summary: 'List my listening history',
        description: "Paginated list of the caller's plays, newest first.",
        security: [{ bearerAuth: [] }],
        querystring: paginationQuerySchema,
        response: {
          200: pageOf(historyItemSchema),
          400: problemSchema,
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listHistory(req.authUser!.id, req.query));
    },
  );

  app.post<{ Body: RecordPlayInput }>(
    '/v1/me/history',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['History'],
        summary: 'Record a play',
        description:
          'Records that the caller played a track. A completed play also increments ' +
          'the track play count, atomically with the history row.',
        security: [{ bearerAuth: [] }],
        body: recordHistoryBody,
        response: {
          201: historyItemSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(201).send(await recordPlay(req.authUser!.id, req.body));
    },
  );

  // 204 declared in the response schema (as on POST /v1/auth/logout) so
  // Fastify's reply typing accepts code(204).
  app.delete(
    '/v1/me/history',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['History'],
        summary: 'Clear my listening history',
        description: "Deletes all of the caller's listening history rows.",
        security: [{ bearerAuth: [] }],
        response: {
          204: { type: 'null' },
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await clearHistory(req.authUser!.id);
      return reply.code(204).send();
    },
  );
}
