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
    'createdAt',
    'updatedAt',
    'items',
  ],
  properties: {
    ...playlistListItemProperties,
    items: { type: 'array', items: playlistItemSchema },
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
  },
} as const;

export const moveTrackBody = {
  type: 'object',
  required: ['position'],
  additionalProperties: false,
  properties: {
    position: { type: 'number' },
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
