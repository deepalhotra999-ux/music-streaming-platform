// Phase 4 — genres. HTTP routes. Thin handlers over the genre service.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, type PaginationQuery } from '../../http/pagination.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import { createGenreBody, genreListQuery, genreSchema, updateGenreBody } from './schemas.js';
import {
  createGenre,
  deleteGenre,
  getGenre,
  listGenres,
  updateGenre,
  type CreateGenreInput,
  type ListGenresQuery,
  type UpdateGenreInput,
} from './service.js';

interface IdParams {
  id: string;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export async function genresRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: PaginationQuery & { q?: string } }>(
    '/v1/genres',
    {
      schema: {
        tags: ['Genres'],
        summary: 'List genres',
        description: 'Public genre catalog with per-genre track counts. Ordered by name.',
        querystring: genreListQuery,
        response: { 200: pageOf(genreSchema), 400: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as ListGenresQuery;
      return reply.code(200).send(await listGenres(query));
    },
  );

  app.get<{ Params: IdParams }>(
    '/v1/genres/:id',
    {
      schema: {
        tags: ['Genres'],
        summary: 'Get genre',
        description: 'Public genre detail with its track count.',
        params: idParams,
        response: { 200: genreSchema, 400: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getGenre(req.params.id));
    },
  );

  app.post<{ Body: CreateGenreInput }>(
    '/v1/genres',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Genres'],
        summary: 'Create genre',
        description: 'Admin-only. Genre names are unique.',
        security: [{ bearerAuth: [] }],
        body: createGenreBody,
        response: {
          201: genreSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(201).send(await createGenre(req.body));
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateGenreInput }>(
    '/v1/genres/:id',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Genres'],
        summary: 'Update genre',
        description: 'Admin-only.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: updateGenreBody,
        response: {
          200: genreSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await updateGenre(req.params.id, req.body));
    },
  );

  app.delete<{ Params: IdParams }>(
    '/v1/genres/:id',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Genres'],
        summary: 'Delete genre',
        description:
          'Admin-only. Hard delete; rejected with 409 while any tracks are ' +
          'assigned to the genre.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: {
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await deleteGenre(req.params.id);
      return reply.code(204).send();
    },
  );
}
