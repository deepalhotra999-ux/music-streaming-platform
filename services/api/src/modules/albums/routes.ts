// Phase 4 — albums. HTTP routes. Thin handlers over the album service.

import type { FastifyInstance } from 'fastify';
import type { AlbumType } from '@prisma/client';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, type PaginationQuery } from '../../http/pagination.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import {
  albumDetailSchema,
  albumListItemSchema,
  albumListQuery,
  createAlbumBody,
  updateAlbumBody,
} from './schemas.js';
import {
  createAlbum,
  deleteAlbum,
  getAlbum,
  listAlbums,
  updateAlbum,
  type CreateAlbumInput,
  type ListAlbumsQuery,
  type UpdateAlbumInput,
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

const albumErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
};

interface AlbumListQuerystring extends PaginationQuery {
  q?: string;
  artistId?: string;
  albumType?: AlbumType;
}

export async function albumsRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: AlbumListQuerystring }>(
    '/v1/albums',
    {
      schema: {
        tags: ['Albums'],
        summary: 'List albums',
        description:
          'Public album catalog. Filter by title search, artist, or album type. ' +
          'Newest releases first.',
        querystring: albumListQuery,
        response: { 200: pageOf(albumListItemSchema), 400: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as ListAlbumsQuery;
      return reply.code(200).send(await listAlbums(query));
    },
  );

  app.get<{ Params: IdParams }>(
    '/v1/albums/:id',
    {
      schema: {
        tags: ['Albums'],
        summary: 'Get album',
        description: 'Public album detail with its track listing in disc/track order.',
        params: idParams,
        response: { 200: albumDetailSchema, 400: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getAlbum(req.params.id));
    },
  );

  app.post<{ Body: CreateAlbumInput }>(
    '/v1/albums',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Albums'],
        summary: 'Create album',
        description: 'Creates an album for an artist the caller owns (or any artist for admins).',
        security: [{ bearerAuth: [] }],
        body: createAlbumBody,
        response: { 201: albumDetailSchema, ...albumErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(201).send(await createAlbum(req.body, req.authUser!));
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateAlbumInput }>(
    '/v1/albums/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Albums'],
        summary: 'Update album',
        description: 'Owner of the album’s artist or admin only.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: updateAlbumBody,
        response: { 200: albumDetailSchema, ...albumErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await updateAlbum(req.params.id, req.body, req.authUser!));
    },
  );

  app.delete<{ Params: IdParams }>(
    '/v1/albums/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Albums'],
        summary: 'Delete album',
        description:
          'Owner of the album’s artist or admin only. Soft delete; rejected ' +
          'with 409 while tracks still reference the album.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { ...albumErrors, 409: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await deleteAlbum(req.params.id, req.authUser!);
      return reply.code(204).send();
    },
  );
}
