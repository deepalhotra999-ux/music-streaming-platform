// Phase 28 — rooms HTTP API. Thin handlers over the rooms service.
// All endpoints require authentication. Rooms are private and invite-only:
// there is no discovery or listing endpoint, and non-members get
// existence-hiding 404s (Phase 4/27 convention).
//
// Real-time state and host commands travel over the WebSocket gateway
// (gateway.ts); HTTP covers lifecycle, membership, and invitations.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import {
  apiRateLimit,
  roomsCreateRateLimit,
  roomsInviteRateLimit,
  roomsJoinRateLimit,
} from '../../http/limits.js';
import {
  createRoomBody,
  createRoomInvitationResponseSchema,
  joinRoomBody,
  roomIdParams,
  roomInvitationParams,
  roomInvitationSchema,
  roomMemberSchema,
  roomStateSchema,
} from './schemas.js';
import {
  createRoom,
  createRoomInvitation,
  endRoom,
  getRoomState,
  joinRoom,
  leaveRoom,
  listRoomInvitations,
  listRoomMembers,
  revokeRoomInvitation,
} from './service.js';
import { broadcastRoomEvent } from './gateway.js';
import { evictAllFromRoom, evictUserFromRoom } from './hub.js';

interface RoomIdParams {
  id: string;
}

interface RoomInvitationParams {
  id: string;
  invitationId: string;
}

interface CreateRoomBody {
  trackIds?: string[];
  playlistId?: string;
}

interface JoinRoomBody {
  token: string;
}

export async function roomsRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const apiLimit = apiRateLimit(config);
  const createLimit = roomsCreateRateLimit(config);
  const joinLimit = roomsJoinRateLimit(config);
  const inviteLimit = roomsInviteRateLimit(config);

  // Create a room. Requires playback entitlement; never grants any.
  app.post<{ Body: CreateRoomBody }>(
    '/v1/rooms',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'Create a listening room',
        security: [{ bearerAuth: [] }],
        body: createRoomBody,
        response: { 201: roomStateSchema, '4xx': problemSchema, '5xx': problemSchema },
      },
      config: { rateLimit: createLimit },
    },
    async (req, reply) => {
      const state = await createRoom(req.authUser!.id, req.body);
      return reply.code(201).send(state);
    },
  );

  // Authoritative room state (members only; 404 otherwise).
  app.get<{ Params: RoomIdParams }>(
    '/v1/rooms/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'Get room state',
        security: [{ bearerAuth: [] }],
        params: roomIdParams,
        response: { 200: roomStateSchema, '4xx': problemSchema, '5xx': problemSchema },
      },
      config: { rateLimit: apiLimit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getRoomState(req.params.id, req.authUser!.id));
    },
  );

  // Join via invitation token. Requires playback entitlement.
  app.post<{ Params: RoomIdParams; Body: JoinRoomBody }>(
    '/v1/rooms/:id/join',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'Join a room with an invitation token',
        security: [{ bearerAuth: [] }],
        params: roomIdParams,
        body: joinRoomBody,
        response: { 200: roomStateSchema, '4xx': problemSchema, '5xx': problemSchema },
      },
      config: { rateLimit: joinLimit },
    },
    async (req, reply) => {
      const { state, isNewMember } = await joinRoom(
        req.params.id,
        req.authUser!.id,
        req.body.token,
      );
      // Only a genuinely new membership announces member_joined. Idempotent
      // rejoins and socket (re)subscribes stay silent.
      if (isNewMember) {
        broadcastRoomEvent(req.params.id, 'member_joined', req.authUser!.id);
      }
      return reply.code(200).send(state);
    },
  );

  // Leave. When the host leaves, the room ends for everyone.
  app.post<{ Params: RoomIdParams }>(
    '/v1/rooms/:id/leave',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'Leave a room',
        security: [{ bearerAuth: [] }],
        params: roomIdParams,
        response: { 204: { type: 'null' }, '4xx': problemSchema, '5xx': problemSchema },
      },
      config: { rateLimit: apiLimit },
    },
    async (req, reply) => {
      const { ended } = await leaveRoom(req.params.id, req.authUser!.id);
      const userId = req.authUser!.id;
      // Broadcast first so every subscriber learns the outcome, then drop
      // subscriptions that are no longer authorized. Membership rows
      // survive END so members can still fetch the terminal ENDED state.
      if (ended) {
        broadcastRoomEvent(req.params.id, 'room_ended', userId);
        evictAllFromRoom(req.params.id);
      } else {
        broadcastRoomEvent(req.params.id, 'member_left', userId);
        evictUserFromRoom(req.params.id, userId);
      }
      return reply.code(204).send();
    },
  );

  // Host ends the room.
  app.post<{ Params: RoomIdParams }>(
    '/v1/rooms/:id/end',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'End a room (host only)',
        security: [{ bearerAuth: [] }],
        params: roomIdParams,
        response: { 204: { type: 'null' }, '4xx': problemSchema, '5xx': problemSchema },
      },
      config: { rateLimit: apiLimit },
    },
    async (req, reply) => {
      await endRoom(req.params.id, req.authUser!.id);
      // The room is over: tell every subscriber, then drop all of their
      // subscriptions. Membership rows survive so clients can resync the
      // terminal ENDED state over HTTP.
      broadcastRoomEvent(req.params.id, 'room_ended', req.authUser!.id);
      evictAllFromRoom(req.params.id);
      return reply.code(204).send();
    },
  );

  // Members (members only).
  app.get<{ Params: RoomIdParams }>(
    '/v1/rooms/:id/members',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'List room members',
        security: [{ bearerAuth: [] }],
        params: roomIdParams,
        response: {
          200: { type: 'array', items: roomMemberSchema },
          '4xx': problemSchema,
          '5xx': problemSchema,
        },
      },
      config: { rateLimit: apiLimit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listRoomMembers(req.params.id, req.authUser!.id));
    },
  );

  // Host creates a single-use invitation. Raw token returned exactly once.
  app.post<{ Params: RoomIdParams }>(
    '/v1/rooms/:id/invitations',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'Create a room invitation (host only)',
        security: [{ bearerAuth: [] }],
        params: roomIdParams,
        response: {
          201: createRoomInvitationResponseSchema,
          '4xx': problemSchema,
          '5xx': problemSchema,
        },
      },
      config: { rateLimit: inviteLimit },
    },
    async (req, reply) => {
      const invitation = await createRoomInvitation(req.params.id, req.authUser!.id);
      return reply.code(201).send(invitation);
    },
  );

  // Host lists invitations (token hashes are never exposed).
  app.get<{ Params: RoomIdParams }>(
    '/v1/rooms/:id/invitations',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'List room invitations (host only)',
        security: [{ bearerAuth: [] }],
        params: roomIdParams,
        response: {
          200: { type: 'array', items: roomInvitationSchema },
          '4xx': problemSchema,
          '5xx': problemSchema,
        },
      },
      config: { rateLimit: apiLimit },
    },
    async (req, reply) => {
      return reply.code(200).send(await listRoomInvitations(req.params.id, req.authUser!.id));
    },
  );

  // Host revokes an invitation.
  app.delete<{ Params: RoomInvitationParams }>(
    '/v1/rooms/:id/invitations/:invitationId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Rooms'],
        summary: 'Revoke a room invitation (host only)',
        security: [{ bearerAuth: [] }],
        params: roomInvitationParams,
        response: { 204: { type: 'null' }, '4xx': problemSchema, '5xx': problemSchema },
      },
      config: { rateLimit: apiLimit },
    },
    async (req, reply) => {
      await revokeRoomInvitation(req.params.id, req.params.invitationId, req.authUser!.id);
      return reply.code(204).send();
    },
  );
}
