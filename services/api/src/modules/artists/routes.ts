// Phase 4 — artists. HTTP routes. Thin handlers over the artist service.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, type PaginationQuery } from '../../http/pagination.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import {
  artistDetailSchema,
  artistListItemSchema,
  artistListQuery,
  artistProfileSchema,
  createArtistBody,
  updateArtistBody,
  upsertProfileBody,
} from './schemas.js';
import {
  createArtist,
  deleteArtist,
  getArtist,
  getArtistProfile,
  listArtists,
  listMyArtists,
  updateArtist,
  upsertArtistProfile,
  type CreateArtistInput,
  type ListArtistsQuery,
  type UpdateArtistInput,
  type UpsertProfileInput,
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

const artistErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
};

export async function artistsRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: PaginationQuery & { q?: string; verified?: 'true' | 'false' } }>(
    '/v1/artists',
    {
      schema: {
        tags: ['Artists'],
        summary: 'List artists',
        description:
          'Public artist catalog. Supports name search and verified filter. ' + 'Ordered by name.',
        querystring: artistListQuery,
        response: { 200: pageOf(artistListItemSchema), 400: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as ListArtistsQuery;
      return reply.code(200).send(await listArtists(query));
    },
  );

  // Registered before /v1/artists/:id so "me" is not parsed as an id.
  app.get<{ Querystring: PaginationQuery }>(
    '/v1/me/artists',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Artists'],
        summary: 'List my artists',
        description: 'Artists owned by the caller, newest first. Any role.',
        security: [{ bearerAuth: [] }],
        querystring: artistListQuery,
        response: { 200: pageOf(artistListItemSchema), 400: problemSchema, 401: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listMyArtists(req.authUser!.id, req.query));
    },
  );

  app.get<{ Params: IdParams }>(
    '/v1/artists/:id',
    {
      schema: {
        tags: ['Artists'],
        summary: 'Get artist',
        description: 'Public artist detail with profile and catalog counts.',
        params: idParams,
        response: { 200: artistDetailSchema, 400: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getArtist(req.params.id));
    },
  );

  app.post<{ Body: CreateArtistInput }>(
    '/v1/artists',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Artists'],
        summary: 'Create artist',
        description:
          'Creates an artist owned by the caller. Only admins may assign a ' +
          'different owner via ownerUserId.',
        security: [{ bearerAuth: [] }],
        body: createArtistBody,
        response: { 201: artistDetailSchema, ...artistErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(201).send(await createArtist(req.body, req.authUser!));
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateArtistInput }>(
    '/v1/artists/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Artists'],
        summary: 'Update artist',
        description:
          'Owner or admin only. The verified flag is admin-only: non-admins ' +
          'passing it receive 403.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: updateArtistBody,
        response: { 200: artistDetailSchema, ...artistErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await updateArtist(req.params.id, req.body, req.authUser!));
    },
  );

  app.delete<{ Params: IdParams }>(
    '/v1/artists/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Artists'],
        summary: 'Delete artist',
        description:
          'Owner or admin only. Soft delete; rejected with 409 while the ' +
          'artist still has albums or tracks.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { ...artistErrors, 409: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await deleteArtist(req.params.id, req.authUser!);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: IdParams }>(
    '/v1/artists/:id/profile',
    {
      schema: {
        tags: ['Artists'],
        summary: 'Get artist profile',
        description: 'Public extended profile (bio, images, links) for an artist.',
        params: idParams,
        response: { 200: artistProfileSchema, 400: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getArtistProfile(req.params.id));
    },
  );

  app.put<{ Params: IdParams; Body: UpsertProfileInput }>(
    '/v1/artists/:id/profile',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Artists'],
        summary: 'Create or replace artist profile',
        description: 'Owner or admin only. Creates the profile row if none exists.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: upsertProfileBody,
        response: { 200: artistProfileSchema, ...artistErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply
        .code(200)
        .send(await upsertArtistProfile(req.params.id, req.body, req.authUser!));
    },
  );
}
