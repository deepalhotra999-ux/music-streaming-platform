// Phase 4 — playlists. HTTP routes. Thin handlers over the playlist service.
// GET /v1/playlists/public and GET /v1/playlists/:id (PUBLIC playlists) are
// the only unauthenticated endpoints here; everything else needs a Bearer
// token and, for writes, playlist ownership.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { badRequest, problemSchema } from '../../http/errors.js';
import { pageOf, paginationQuerySchema, type PaginationQuery } from '../../http/pagination.js';
import { apiRateLimit } from '../../http/limits.js';
import {
  acceptInvitationBody,
  addTrackBody,
  createInvitationResponseSchema,
  createPlaylistBody,
  moveTrackBody,
  playlistChangeSchema,
  playlistChangesQuery,
  playlistDetailSchema,
  playlistIdParams,
  playlistInvitationParams,
  playlistInvitationSchema,
  playlistItemParams,
  playlistItemSchema,
  playlistListItemSchema,
  playlistMemberParams,
  playlistMemberSchema,
  publicPlaylistQuery,
  setCollaborativeBody,
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
import {
  acceptInvitation,
  createInvitation,
  leavePlaylist,
  listChanges,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  setCollaborative,
} from './collab.js';

interface PlaylistIdParams {
  id: string;
}

interface PlaylistItemParams {
  id: string;
  itemId: string;
}

interface PlaylistMemberParams {
  id: string;
  memberUserId: string;
}

interface PlaylistInvitationParams {
  id: string;
  invitationId: string;
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
          'Owner or editor. Appends at max(position) + 1 when no position is given. ' +
          'The track must exist and not be deleted. On collaborative playlists ' +
          'expectedRevision is required; stale writes get a 409 conflict. ' +
          'The new revision is returned in the x-playlist-revision header.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        body: addTrackBody,
        response: {
          201: playlistItemSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const { item, revision } = await addTrackToPlaylist(
        req.params.id,
        req.authUser!.id,
        req.body,
      );
      return reply.code(201).header('x-playlist-revision', String(revision)).send(item);
    },
  );

  app.patch<{ Params: PlaylistItemParams; Body: { position: number; expectedRevision?: number } }>(
    '/v1/playlists/:id/tracks/:itemId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Move a playlist item',
        description:
          'Owner or editor. Repositions an existing playlist item. On collaborative ' +
          'playlists expectedRevision is required; stale writes get a 409 conflict. ' +
          'The new revision is returned in the x-playlist-revision header.',
        security: [{ bearerAuth: [] }],
        params: playlistItemParams,
        body: moveTrackBody,
        response: {
          200: playlistItemSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const { item, revision } = await movePlaylistItem(
        req.params.id,
        req.params.itemId,
        req.authUser!.id,
        req.body.position,
        req.body.expectedRevision,
      );
      return reply.code(200).header('x-playlist-revision', String(revision)).send(item);
    },
  );

  app.delete<{ Params: PlaylistItemParams; Body: { expectedRevision?: number } }>(
    '/v1/playlists/:id/tracks/:itemId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Remove a track from a playlist',
        description:
          'Owner or editor. Removes the playlist item. On collaborative playlists ' +
          'expectedRevision is required; stale writes get a 409 conflict. ' +
          'The new revision is returned in the x-playlist-revision header. ' +
          'The body is optional: a bodyless DELETE keeps the pre-Phase-27 ' +
          'behavior for non-collaborative playlists.',
        security: [{ bearerAuth: [] }],
        params: playlistItemParams,
        response: {
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      // No body schema is declared on purpose: a bodyless DELETE must keep
      // working (legacy behavior). When a body is present, expectedRevision
      // — the only field the service reads — is validated here.
      const rawRevision = (req.body as { expectedRevision?: unknown } | undefined)
        ?.expectedRevision;
      if (
        rawRevision !== undefined &&
        (!Number.isInteger(rawRevision) || (rawRevision as number) < 0)
      ) {
        throw badRequest('expectedRevision must be a non-negative integer.');
      }
      const { revision } = await removePlaylistItem(
        req.params.id,
        req.params.itemId,
        req.authUser!.id,
        rawRevision as number | undefined,
      );
      return reply.code(204).header('x-playlist-revision', String(revision)).send();
    },
  );

  // Phase 27 — collaboration endpoints.

  app.patch<{ Params: PlaylistIdParams; Body: { isCollaborative: boolean } }>(
    '/v1/playlists/:id/collaboration',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Enable or disable collaboration',
        description:
          'Owner only. Disabling collaboration removes all members and revokes ' +
          'outstanding invitations immediately.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        body: setCollaborativeBody,
        response: {
          200: {
            type: 'object',
            required: ['isCollaborative', 'revision'],
            additionalProperties: false,
            properties: {
              isCollaborative: { type: 'boolean' },
              revision: { type: 'integer', minimum: 0 },
            },
          },
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
        .send(await setCollaborative(req.params.id, req.authUser!.id, req.body.isCollaborative));
    },
  );

  app.get<{ Params: PlaylistIdParams }>(
    '/v1/playlists/:id/members',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'List playlist members',
        description: 'Members only. Non-members get 404.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        response: {
          200: { type: 'array', items: playlistMemberSchema },
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listMembers(req.params.id, req.authUser!.id));
    },
  );

  app.post<{ Params: PlaylistIdParams }>(
    '/v1/playlists/:id/invitations',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Create an invitation',
        description:
          'Owner only. Returns the raw bearer token exactly once — it is never ' +
          'stored server-side, only its SHA-256 hash. Tokens expire after 7 days ' +
          'and are single-use.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        response: {
          201: createInvitationResponseSchema,
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(201).send(await createInvitation(req.params.id, req.authUser!.id));
    },
  );

  app.get<{ Params: PlaylistIdParams }>(
    '/v1/playlists/:id/invitations',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'List invitations',
        description: 'Owner only. Never includes token material.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        response: {
          200: { type: 'array', items: playlistInvitationSchema },
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listInvitations(req.params.id, req.authUser!.id));
    },
  );

  app.post<{ Body: { token: string } }>(
    '/v1/playlists/invitations/accept',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Accept an invitation',
        description:
          'The caller is derived from the auth token; the invitation token alone ' +
          'grants nothing without a signed-in user. Expired, revoked, or reused ' +
          'tokens are rejected.',
        security: [{ bearerAuth: [] }],
        body: acceptInvitationBody,
        response: {
          200: playlistDetailSchema,
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
      return reply.code(200).send(await acceptInvitation(req.body.token, req.authUser!));
    },
  );

  app.delete<{ Params: PlaylistInvitationParams }>(
    '/v1/playlists/:id/invitations/:invitationId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Revoke an invitation',
        description: 'Owner only. Already-used invitations cannot be revoked.',
        security: [{ bearerAuth: [] }],
        params: playlistInvitationParams,
        response: {
          401: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await revokeInvitation(req.params.id, req.params.invitationId, req.authUser!.id);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: PlaylistIdParams }>(
    '/v1/playlists/:id/members/me',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Leave a collaborative playlist',
        description: 'Editors only. Owners cannot leave; they delete the playlist instead.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        response: {
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await leavePlaylist(req.params.id, req.authUser!.id);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: PlaylistMemberParams }>(
    '/v1/playlists/:id/members/:memberUserId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'Remove a member',
        description:
          'Owner only. The owner can never be removed. Removed members lose ' +
          'access immediately.',
        security: [{ bearerAuth: [] }],
        params: playlistMemberParams,
        response: {
          400: problemSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await removeMember(req.params.id, req.params.memberUserId, req.authUser!.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: PlaylistIdParams; Querystring: { limit?: string } }>(
    '/v1/playlists/:id/changes',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Playlists'],
        summary: 'List change history',
        description: 'Members only. Append-only history, newest first. Non-members get 404.',
        security: [{ bearerAuth: [] }],
        params: playlistIdParams,
        querystring: playlistChangesQuery,
        response: {
          200: { type: 'array', items: playlistChangeSchema },
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
      return reply.code(200).send(await listChanges(req.params.id, req.authUser!.id, limit));
    },
  );
}
