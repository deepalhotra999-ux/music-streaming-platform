// Phase 4 — tracks. HTTP routes. Thin handlers over the track service.

import type { FastifyInstance } from 'fastify';
import type { TrackStatus } from '@prisma/client';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, type PaginationQuery } from '../../http/pagination.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import {
  createTrackBody,
  trackDetailSchema,
  trackListItemSchema,
  trackListQuery,
  updateTrackBody,
} from './schemas.js';
import {
  createTrack,
  deleteTrack,
  getTrack,
  listTracks,
  updateTrack,
  type CreateTrackInput,
  type ListTracksQuery,
  type UpdateTrackInput,
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

const trackErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
};

interface TrackListQuerystring extends PaginationQuery {
  q?: string;
  artistId?: string;
  albumId?: string;
  genreId?: string;
  status?: TrackStatus;
}

export async function tracksRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: TrackListQuerystring }>(
    '/v1/tracks',
    {
      schema: {
        tags: ['Tracks'],
        summary: 'List tracks',
        description:
          'Public track catalog. Filter by title search, artist, album, genre, ' +
          'or processing status. Newest first.',
        querystring: trackListQuery,
        response: { 200: pageOf(trackListItemSchema), 400: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as ListTracksQuery;
      return reply.code(200).send(await listTracks(query));
    },
  );

  app.get<{ Params: IdParams }>(
    '/v1/tracks/:id',
    {
      schema: {
        tags: ['Tracks'],
        summary: 'Get track',
        description: 'Public track detail with genres and like count.',
        params: idParams,
        response: { 200: trackDetailSchema, 400: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getTrack(req.params.id));
    },
  );

  app.post<{ Body: CreateTrackInput }>(
    '/v1/tracks',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      schema: {
        tags: ['Tracks'],
        summary: 'Create track',
        description:
          'Creates a track for an artist the caller owns (or any artist for ' +
          'admins). An albumId must reference an album of the same artist. ' +
          'New tracks start in PROCESSING until the ingestion pipeline marks ' +
          'them READY.',
        security: [{ bearerAuth: [] }],
        body: createTrackBody,
        response: { 201: trackDetailSchema, ...trackErrors, 409: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(201).send(await createTrack(req.body, req.authUser!));
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateTrackInput }>(
    '/v1/tracks/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Tracks'],
        summary: 'Update track',
        description: 'Owner of the track’s artist or admin only.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: updateTrackBody,
        response: { 200: trackDetailSchema, ...trackErrors, 409: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await updateTrack(req.params.id, req.body, req.authUser!));
    },
  );

  app.delete<{ Params: IdParams }>(
    '/v1/tracks/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Tracks'],
        summary: 'Delete track',
        description:
          'Owner of the track’s artist or admin only. Soft delete; rejected ' +
          'with 409 while the track appears in any playlist.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { ...trackErrors, 409: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await deleteTrack(req.params.id, req.authUser!);
      return reply.code(204).send();
    },
  );
}
