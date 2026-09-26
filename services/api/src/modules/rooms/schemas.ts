// Phase 28 — JSON Schemas for the rooms HTTP API.

export const roomIdParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
  additionalProperties: false,
} as const;

export const roomInvitationParams = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    invitationId: { type: 'string', format: 'uuid' },
  },
  required: ['id', 'invitationId'],
  additionalProperties: false,
} as const;

export const createRoomBody = {
  type: 'object',
  properties: {
    trackIds: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      minItems: 1,
      maxItems: 200,
    },
    playlistId: { type: 'string', format: 'uuid' },
  },
  additionalProperties: false,
} as const;

export const joinRoomBody = {
  type: 'object',
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 256 },
  },
  required: ['token'],
  additionalProperties: false,
} as const;

const roomTrackSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    artistName: { type: 'string' },
    durationMs: { type: 'integer' },
    artworkUrl: { type: ['string', 'null'] },
  },
  required: ['id', 'title', 'artistName', 'durationMs', 'artworkUrl'],
  additionalProperties: false,
} as const;

export const roomStateSchema = {
  type: 'object',
  properties: {
    roomId: { type: 'string' },
    revision: { type: 'integer' },
    status: { type: 'string', enum: ['ACTIVE', 'ENDED'] },
    playbackState: { type: 'string', enum: ['PLAYING', 'PAUSED'] },
    currentTrackId: { type: ['string', 'null'] },
    currentTrack: { ...roomTrackSummarySchema, nullable: true },
    queueIndex: { type: 'integer' },
    queue: { type: 'array', items: roomTrackSummarySchema },
    positionMs: { type: 'integer' },
    serverTime: { type: 'string', format: 'date-time' },
    role: { type: 'string', enum: ['HOST', 'PARTICIPANT'] },
  },
  required: [
    'roomId',
    'revision',
    'status',
    'playbackState',
    'currentTrackId',
    'currentTrack',
    'queueIndex',
    'queue',
    'positionMs',
    'serverTime',
    'role',
  ],
  additionalProperties: false,
} as const;

export const roomMemberSchema = {
  type: 'object',
  properties: {
    userId: { type: 'string' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: ['HOST', 'PARTICIPANT'] },
    joinedAt: { type: 'string', format: 'date-time' },
  },
  required: ['userId', 'displayName', 'role', 'joinedAt'],
  additionalProperties: false,
} as const;

export const roomInvitationSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
    usedAt: { type: ['string', 'null'], format: 'date-time' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'expiresAt', 'usedAt', 'revokedAt', 'createdAt'],
  additionalProperties: false,
} as const;

export const createRoomInvitationResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    token: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
    usedAt: { type: ['string', 'null'], format: 'date-time' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'token', 'expiresAt', 'usedAt', 'revokedAt', 'createdAt'],
  additionalProperties: false,
} as const;
