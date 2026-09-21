// Phase 4 — playlists. HTTP routes. Thin handlers over the playlist service.
// GET /v1/playlists/public and GET /v1/playlists/:id (PUBLIC playlists) are
// the only unauthenticated endpoints here; everything else needs a Bearer
// token and, for writes, playlist ownership.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, paginationQuerySchema, type PaginationQuery } from '../../http/pagination.js';
import { apiRateLimit } from '../../http/limits.js';
import {
  addTrackBody,
  createPlaylistBody,
  moveTrackBody,
  playlistDetailSchema,
  playlistIdParams,
  playlistItemParams,
  playlistItemSchema,
  playlistListItemSchema,
  publicPlaylistQuery,
  updatePlaylistBody,
} from './schemas.js';
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylistDetail,
  listMyPlaylists,
  listPublicPlaylists,
  movePlaylistItem,
  removePlaylistItem,
  updatePlaylist,
  type AddTrackInput,
  type CreatePlaylistInput,
  type ListPublicPlaylistsQuery,
  type UpdatePlaylistInput,
} from './service.js';

interface PlaylistIdParams {
  id: string;
}

interface PlaylistItemParams {
  id: string;
  itemId: string;
}

export async function playlistsRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: ListPublicPlaylistsQuery }>(
    '/v1/playlists/public',
    {
      schema: {
        tags: ['Playlists'],
        summary: 'Browse public playlists',
        description:
          'Paginated list of PUBLIC playlists, newest first. No authentication required. ' +
          'Supports title search via q.',
        querystring: publicPlaylistQuery,
        response: {
          200: pageOf(playlistListItemSchema),
          400: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listPublicPlaylists(req.query));
    },
  );

  app.get<{ Querystring: PaginationQuery }>(
    '/v1/me/playlists',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'List my playlists',
        description: "Paginated list of the caller's playlists (any visibility), newest first.",
        security: [{ bearerAuth: [] }],
        querystring: paginationQuerySchema,
        response: {
          200: pageOf(playlistListItemSchema),
          400: problemSchema,
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listMyPlaylists(req.authUser!.id, req.query));
    },
  );

  app.get<{ Params: PlaylistIdParams }>(
    '/v1/playlists/:id',
    {
      // Optional: populates req.authUser when a token is present so the
      // service can apply PUBLIC / UNLISTED / PRIVATE visibility rules.
      preHandler: [app.authenticateOptional],
      schema: {
        tags: ['Playlists'],
        summary: 'Get playlist detail',
        description:
          'Playlist with its ordered tracks. PUBLIC playlists need no auth; UNLISTED ' +
          'needs a signed-in user; PRIVATE is owner-only (others get 404).',
        params: playlistIdParams,
        response: {
          200: playlistDetailSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getPlaylistDetail(req.params.id, req.authUser));
    },
  );

  app.post<{ Body: CreatePlaylistInput }>(
    '/v1/playlists',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Create a playlist',
        description: 'Creates a playlist owned by the caller. Defaults to PRIVATE.',
        security: [{ bearerAuth: [] }],
        body: createPlaylistBody,
        response: {
          201: playlistDetailSchema,
          400: problemSchema,
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(201).send(await createPlaylist(req.authUser!.id, req.body));
    },
  );

  app.patch<{ Params: PlaylistIdParams; Body: UpdatePlaylistInput }>(
    '/v1/playlists/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Update a playlist',
        description: 'Owner only. Non-owners get 404.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        body: updatePlaylistBody,
        response: {
          200: playlistDetailSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await updatePlaylist(req.params.id, req.authUser!.id, req.body));
    },
  );

  app.delete<{ Params: PlaylistIdParams }>(
    '/v1/playlists/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Delete a playlist',
        description: 'Owner only. Soft delete. Non-owners get 404.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        response: {
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await deletePlaylist(req.params.id, req.authUser!.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: PlaylistIdParams; Body: AddTrackInput }>(
    '/v1/playlists/:id/tracks',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Add a track to a playlist',
        description:
          'Owner only. Appends at max(position) + 1 when no position is given. ' +
          'The track must exist and not be deleted.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        body: addTrackBody,
        response: {
          201: playlistItemSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply
        .code(201)
        .send(await addTrackToPlaylist(req.params.id, req.authUser!.id, req.body));
    },
  );

  app.patch<{ Params: PlaylistItemParams; Body: { position: number } }>(
    '/v1/playlists/:id/tracks/:itemId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Move a playlist item',
        description: 'Owner only. Repositions an existing playlist item.',
        security: [{ bearerAuth: [] }],
        params: playlistItemParams,
        body: moveTrackBody,
        response: {
          200: playlistItemSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply
        .code(200)
        .send(
          await movePlaylistItem(
            req.params.id,
            req.params.itemId,
            req.authUser!.id,
            req.body.position,
          ),
        );
    },
  );

  app.delete<{ Params: PlaylistItemParams }>(
    '/v1/playlists/:id/tracks/:itemId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Remove a track from a playlist',
        description: 'Owner only. Removes the playlist item.',
        security: [{ bearerAuth: [] }],
        params: playlistItemParams,
        response: {
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await removePlaylistItem(req.params.id, req.params.itemId, req.authUser!.id);
      return reply.code(204).send();
    },
  );
}
