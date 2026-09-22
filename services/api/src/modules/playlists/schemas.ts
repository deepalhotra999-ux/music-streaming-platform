// Phase 4 — playlists. JSON Schemas: request validation and response shapes.
// Visibility rules (see service.ts): PUBLIC = anyone, UNLISTED = any
// signed-in user, PRIVATE = owner only (non-owners get 404).

import { trackSummarySchema } from '../summaries.js';

export const playlistItemSchema = {
  type: 'object',
  required: ['id', 'position', 'addedAt', 'track'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    position: { type: 'number' },
    addedAt: { type: 'string', format: 'date-time' },
    track: trackSummarySchema,
  },
} as const;

const playlistListItemProperties = {
  id: { type: 'string', format: 'uuid' },
  title: { type: 'string' },
  description: { type: ['string', 'null'] },
  coverArtUrl: { type: ['string', 'null'] },
  visibility: { type: 'string', enum: ['PRIVATE', 'PUBLIC', 'UNLISTED'] },
  ownerUserId: { type: 'string', format: 'uuid' },
  ownerDisplayName: { type: 'string' },
  trackCount: { type: 'integer' },
  // Phase 27 — collaborative playlists.
  isCollaborative: { type: 'boolean' },
  revision: { type: 'integer', minimum: 0 },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
} as const;

export const playlistListItemSchema = {
  type: 'object',
  required: [
    'id',
    'title',
    'description',
    'coverArtUrl',
    'visibility',
    'ownerUserId',
    'ownerDisplayName',
    'trackCount',
    'isCollaborative',
    'revision',
    'createdAt',
    'updatedAt',
  ],
  properties: playlistListItemProperties,
} as const;

export const playlistDetailSchema = {
  type: 'object',
  required: [
    'id',
    'title',
    'description',
    'coverArtUrl',
    'visibility',
    'ownerUserId',
    'ownerDisplayName',
    'trackCount',
    'isCollaborative',
    'revision',
    'createdAt',
    'updatedAt',
    'items',
    'viewerRole',
  ],
  properties: {
    ...playlistListItemProperties,
    items: { type: 'array', items: playlistItemSchema },
    viewerRole: { type: ['string', 'null'], enum: ['OWNER', 'EDITOR', null] },
  },
} as const;

const playlistFields = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  description: { type: ['string', 'null'], maxLength: 1000 },
  coverArtUrl: { type: ['string', 'null'], format: 'uri', maxLength: 2048 },
  visibility: { type: 'string', enum: ['PRIVATE', 'PUBLIC', 'UNLISTED'] },
} as const;

export const createPlaylistBody = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: playlistFields,
} as const;

export const updatePlaylistBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: playlistFields,
} as const;

export const addTrackBody = {
  type: 'object',
  required: ['trackId'],
  additionalProperties: false,
  properties: {
    trackId: { type: 'string', format: 'uuid' },
    position: { type: 'number' },
    // Phase 27 — required on collaborative playlists (optimistic concurrency).
    expectedRevision: { type: 'integer', minimum: 0 },
  },
} as const;

export const moveTrackBody = {
  type: 'object',
  required: ['position'],
  additionalProperties: false,
  properties: {
    position: { type: 'number' },
    // Phase 27 — required on collaborative playlists (optimistic concurrency).
    expectedRevision: { type: 'integer', minimum: 0 },
  },
} as const;

export const removeTrackBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Phase 27 — required on collaborative playlists (optimistic concurrency).
    expectedRevision: { type: 'integer', minimum: 0 },
  },
} as const;

// Phase 27 — collaboration schemas.

export const setCollaborativeBody = {
  type: 'object',
  required: ['isCollaborative'],
  additionalProperties: false,
  properties: {
    isCollaborative: { type: 'boolean' },
  },
} as const;

export const playlistMemberSchema = {
  type: 'object',
  required: ['userId', 'displayName', 'role', 'joinedAt'],
  properties: {
    userId: { type: 'string', format: 'uuid' },
    displayName: { type: 'string' },
    role: { type: 'string', enum: ['OWNER', 'EDITOR'] },
    joinedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const playlistInvitationSchema = {
  type: 'object',
  required: ['id', 'expiresAt', 'usedAt', 'revokedAt', 'createdByUserId', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    expiresAt: { type: 'string', format: 'date-time' },
    usedAt: { type: ['string', 'null'], format: 'date-time' },
    revokedAt: { type: ['string', 'null'], format: 'date-time' },
    createdByUserId: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const createInvitationResponseSchema = {
  type: 'object',
  required: ['token', 'invitation'],
  properties: {
    // Raw bearer token — returned exactly once, never stored server-side.
    token: { type: 'string', minLength: 1 },
    invitation: playlistInvitationSchema,
  },
} as const;

export const acceptInvitationBody = {
  type: 'object',
  required: ['token'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export const playlistMemberParams = {
  type: 'object',
  required: ['id', 'memberUserId'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    memberUserId: { type: 'string', format: 'uuid' },
  },
} as const;

export const playlistInvitationParams = {
  type: 'object',
  required: ['id', 'invitationId'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    invitationId: { type: 'string', format: 'uuid' },
  },
} as const;

export const playlistChangeSchema = {
  type: 'object',
  required: [
    'id',
    'actorUserId',
    'actorDisplayName',
    'action',
    'trackId',
    'itemId',
    'revision',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    actorUserId: { type: 'string', format: 'uuid' },
    actorDisplayName: { type: 'string' },
    action: {
      type: 'string',
      enum: [
        'TRACK_ADDED',
        'TRACK_REMOVED',
        'TRACK_MOVED',
        'COLLAB_ENABLED',
        'COLLAB_DISABLED',
        'MEMBER_ADDED',
        'MEMBER_REMOVED',
        'MEMBER_LEFT',
        'INVITATION_CREATED',
        'INVITATION_ACCEPTED',
        'INVITATION_REVOKED',
      ],
    },
    trackId: { type: ['string', 'null'], format: 'uuid' },
    itemId: { type: ['string', 'null'], format: 'uuid' },
    revision: { type: 'integer', minimum: 0 },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const playlistChangesQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
} as const;

export const publicPlaylistQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'string', pattern: '^[1-9][0-9]*$' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
    q: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

export const playlistIdParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;

export const playlistItemParams = {
  type: 'object',
  required: ['id', 'itemId'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    itemId: { type: 'string', format: 'uuid' },
  },
} as const;
