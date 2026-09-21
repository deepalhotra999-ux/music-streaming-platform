// Phase 4 — tracks. Fastify (ajv) JSON Schemas for request validation and
// response serialization. Declared once, enforced at runtime.

const uuid = { type: 'string', format: 'uuid' } as const;
const page = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;
const limit = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;

const statusEnum = {
  type: 'string',
  enum: ['PROCESSING', 'READY', 'FAILED', 'TAKEDOWN'],
} as const;

const genreRefSchema = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: uuid,
    name: { type: 'string' },
  },
} as const;

export const trackListItemSchema = {
  type: 'object',
  required: [
    'id',
    'title',
    'artistId',
    'artistName',
    'albumId',
    'albumTitle',
    'durationMs',
    'trackNumber',
    'discNumber',
    'status',
    'playCount',
    'createdAt',
  ],
  properties: {
    id: uuid,
    title: { type: 'string' },
    artistId: uuid,
    artistName: { type: 'string' },
    albumId: { type: ['string', 'null'], format: 'uuid' },
    albumTitle: { type: ['string', 'null'] },
    durationMs: { type: 'integer', minimum: 1 },
    trackNumber: { type: ['integer', 'null'], minimum: 1 },
    discNumber: { type: 'integer', minimum: 1 },
    status: statusEnum,
    playCount: { type: 'integer', minimum: 0 },
    createdAt: dateTime,
  },
} as const;

export const trackDetailSchema = {
  type: 'object',
  required: [
    'id',
    'title',
    'artistId',
    'artistName',
    'albumId',
    'albumTitle',
    'durationMs',
    'trackNumber',
    'discNumber',
    'status',
    'playCount',
    'createdAt',
    'isrc',
    'genres',
    'likeCount',
  ],
  properties: {
    id: uuid,
    title: { type: 'string' },
    artistId: uuid,
    artistName: { type: 'string' },
    albumId: { type: ['string', 'null'], format: 'uuid' },
    albumTitle: { type: ['string', 'null'] },
    durationMs: { type: 'integer', minimum: 1 },
    trackNumber: { type: ['integer', 'null'], minimum: 1 },
    discNumber: { type: 'integer', minimum: 1 },
    status: statusEnum,
    playCount: { type: 'integer', minimum: 0 },
    createdAt: dateTime,
    isrc: { type: ['string', 'null'] },
    genres: { type: 'array', items: genreRefSchema },
    likeCount: { type: 'integer', minimum: 0 },
  },
} as const;

export const trackListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page,
    limit,
    q: { type: 'string', maxLength: 100 },
    artistId: uuid,
    albumId: uuid,
    genreId: uuid,
    status: statusEnum,
  },
} as const;

export const createTrackBody = {
  type: 'object',
  required: ['title', 'artistId', 'durationMs'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    artistId: uuid,
    albumId: { type: ['string', 'null'], format: 'uuid' },
    durationMs: { type: 'integer', minimum: 1, maximum: 7200000 },
    trackNumber: { type: ['integer', 'null'], minimum: 1 },
    discNumber: { type: 'integer', minimum: 1, default: 1 },
    isrc: { type: ['string', 'null'], maxLength: 32 },
    status: statusEnum,
  },
} as const;

export const updateTrackBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    albumId: { type: ['string', 'null'], format: 'uuid' },
    durationMs: { type: 'integer', minimum: 1, maximum: 7200000 },
    trackNumber: { type: ['integer', 'null'], minimum: 1 },
    discNumber: { type: 'integer', minimum: 1 },
    isrc: { type: ['string', 'null'], maxLength: 32 },
    status: statusEnum,
  },
} as const;
