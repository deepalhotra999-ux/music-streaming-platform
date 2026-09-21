// Phase 4 — albums. Fastify (ajv) JSON Schemas for request validation and
// response serialization. Declared once, enforced at runtime.

const uuid = { type: 'string', format: 'uuid' } as const;
const page = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;
const limit = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableString = { type: ['string', 'null'] } as const;

const albumTypeEnum = { type: 'string', enum: ['ALBUM', 'SINGLE', 'EP', 'COMPILATION'] } as const;

export const albumListItemSchema = {
  type: 'object',
  required: [
    'id',
    'title',
    'artistId',
    'artistName',
    'albumType',
    'releaseDate',
    'coverArtUrl',
    'trackCount',
    'createdAt',
  ],
  properties: {
    id: uuid,
    title: { type: 'string' },
    artistId: uuid,
    artistName: { type: 'string' },
    albumType: albumTypeEnum,
    releaseDate: { type: ['string', 'null'], format: 'date-time' },
    coverArtUrl: nullableString,
    trackCount: { type: 'integer', minimum: 0 },
    createdAt: dateTime,
  },
} as const;

const albumTrackSchema = {
  type: 'object',
  required: ['id', 'title', 'durationMs', 'trackNumber', 'discNumber', 'status'],
  properties: {
    id: uuid,
    title: { type: 'string' },
    durationMs: { type: 'integer', minimum: 1 },
    trackNumber: { type: ['integer', 'null'], minimum: 1 },
    discNumber: { type: 'integer', minimum: 1 },
    status: { type: 'string' },
  },
} as const;

export const albumDetailSchema = {
  type: 'object',
  required: [
    'id',
    'title',
    'artistId',
    'artistName',
    'albumType',
    'releaseDate',
    'coverArtUrl',
    'trackCount',
    'createdAt',
    'tracks',
  ],
  properties: {
    id: uuid,
    title: { type: 'string' },
    artistId: uuid,
    artistName: { type: 'string' },
    albumType: albumTypeEnum,
    releaseDate: { type: ['string', 'null'], format: 'date-time' },
    coverArtUrl: nullableString,
    trackCount: { type: 'integer', minimum: 0 },
    createdAt: dateTime,
    tracks: { type: 'array', items: albumTrackSchema },
  },
} as const;

export const albumListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page,
    limit,
    q: { type: 'string', maxLength: 100 },
    artistId: uuid,
    albumType: albumTypeEnum,
  },
} as const;

export const createAlbumBody = {
  type: 'object',
  required: ['title', 'artistId'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    artistId: uuid,
    albumType: albumTypeEnum,
    releaseDate: { type: 'string', format: 'date' },
    coverArtUrl: nullableString,
  },
} as const;

export const updateAlbumBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    albumType: albumTypeEnum,
    releaseDate: { type: ['string', 'null'], format: 'date' },
    coverArtUrl: { type: ['string', 'null'], format: 'uri', maxLength: 2048 },
  },
} as const;
