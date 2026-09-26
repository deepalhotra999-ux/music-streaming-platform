// Phase 29 — artist/fan community. JSON Schemas for the community API.
//
// Design notes:
// - Posts reference catalog rows by ID only; the catalog stays the single
//   source of truth (no metadata copy). Track/album summaries are resolved
//   at read time.
// - Bodies are length-capped here AND in the service (defense in depth);
//   the service trims and rejects blank/over-long input.
// - Author identity is never accepted from the client: routes derive the
//   user id from the authenticated request.

import { paginationQuerySchema } from '../../http/pagination.js';

export const communityContentStatusSchema = {
  type: 'string',
  enum: ['ACTIVE', 'REMOVED', 'DELETED'],
} as const;

const uuid = { type: 'string', format: 'uuid' } as const;

/** Safe public author shape: id + display name + avatar only. Never email,
 *  role, or any private user field. */
export const communityAuthorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'displayName'],
  properties: {
    id: uuid,
    displayName: { type: 'string' },
    avatarUrl: { type: ['string', 'null'] },
  },
} as const;

const artistRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'verified'],
  properties: {
    id: uuid,
    name: { type: 'string' },
    verified: { type: 'boolean' },
  },
} as const;

const trackRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'artistName', 'durationMs'],
  properties: {
    id: uuid,
    title: { type: 'string' },
    artistName: { type: 'string' },
    durationMs: { type: 'number' },
    albumTitle: { type: ['string', 'null'] },
  },
} as const;

const albumRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'artistName'],
  properties: {
    id: uuid,
    title: { type: 'string' },
    artistName: { type: 'string' },
    coverArtUrl: { type: ['string', 'null'] },
  },
} as const;

export const artistPostSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'artist',
    'author',
    'body',
    'status',
    'reactionCount',
    'commentCount',
    'publishedAt',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: uuid,
    artist: artistRefSchema,
    author: communityAuthorSchema,
    body: { type: 'string' },
    track: { ...trackRefSchema, type: ['object', 'null'] },
    album: { ...albumRefSchema, type: ['object', 'null'] },
    status: communityContentStatusSchema,
    reactionCount: { type: 'number' },
    commentCount: { type: 'number' },
    /** Authenticated views only; null on public views. */
    viewerReacted: { type: ['boolean', 'null'] },
    publishedAt: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const postCommentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'postId', 'author', 'body', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: uuid,
    postId: uuid,
    author: communityAuthorSchema,
    body: { type: 'string' },
    status: communityContentStatusSchema,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const createPostBody = {
  type: 'object',
  additionalProperties: false,
  required: ['artistId', 'body'],
  properties: {
    artistId: uuid,
    body: { type: 'string', minLength: 1, maxLength: 2000 },
    trackId: { ...uuid },
    albumId: { ...uuid },
  },
} as const;

export const updatePostBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    body: { type: 'string', minLength: 1, maxLength: 2000 },
    // Nullable: explicitly clearing an attachment is allowed.
    trackId: { type: ['string', 'null'], format: 'uuid' },
    albumId: { type: ['string', 'null'], format: 'uuid' },
  },
} as const;

export const createCommentBody = {
  type: 'object',
  additionalProperties: false,
  required: ['body'],
  properties: {
    body: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

/** User-facing report filing (Phase 17 workflow, community targets only). */
export const createCommunityReportBody = {
  type: 'object',
  additionalProperties: false,
  required: ['targetType', 'targetId', 'reason'],
  properties: {
    targetType: { type: 'string', enum: ['ARTIST_POST', 'POST_COMMENT', 'PRODUCT', 'ARTIST_STORE'] },
    targetId: uuid,
    reason: { type: 'string', minLength: 3, maxLength: 2000 },
    details: { type: 'string', maxLength: 5000 },
  },
} as const;

export const communityListQuery = {
  ...paginationQuerySchema,
} as const;

export const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: uuid },
} as const;

export const postIdParams = {
  type: 'object',
  required: ['postId'],
  additionalProperties: false,
  properties: { postId: uuid },
} as const;
