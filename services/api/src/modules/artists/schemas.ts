// Phase 4 — artists. Fastify (ajv) JSON Schemas for request validation and
// response serialization. Declared once, enforced at runtime.

const uuid = { type: 'string', format: 'uuid' } as const;
const page = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;
const limit = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;

export const artistProfileSchema = {
  type: 'object',
  required: ['bio', 'imageUrl', 'bannerUrl', 'website', 'socialLinks'],
  properties: {
    bio: { type: ['string', 'null'] },
    imageUrl: { type: ['string', 'null'] },
    bannerUrl: { type: ['string', 'null'] },
    website: { type: ['string', 'null'] },
    socialLinks: { type: ['object', 'null'] },
  },
} as const;

export const artistListItemSchema = {
  type: 'object',
  required: ['id', 'name', 'verified', 'followerCount', 'createdAt'],
  properties: {
    id: uuid,
    name: { type: 'string' },
    verified: { type: 'boolean' },
    followerCount: { type: 'integer', minimum: 0 },
    createdAt: dateTime,
  },
} as const;

export const artistDetailSchema = {
  type: 'object',
  required: ['id', 'name', 'verified', 'createdAt', 'updatedAt', 'profile', 'counts'],
  properties: {
    id: uuid,
    name: { type: 'string' },
    verified: { type: 'boolean' },
    createdAt: dateTime,
    updatedAt: dateTime,
    profile: { anyOf: [artistProfileSchema, { type: 'null' }] },
    counts: {
      type: 'object',
      required: ['albums', 'tracks', 'followers'],
      properties: {
        albums: { type: 'integer', minimum: 0 },
        tracks: { type: 'integer', minimum: 0 },
        followers: { type: 'integer', minimum: 0 },
      },
    },
  },
} as const;

export const artistListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page,
    limit,
    q: { type: 'string', maxLength: 100 },
    verified: { type: 'string', enum: ['true', 'false'] },
  },
} as const;

export const createArtistBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    ownerUserId: uuid,
  },
} as const;

export const updateArtistBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    verified: { type: 'boolean' },
  },
} as const;

export const upsertProfileBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    bio: { type: ['string', 'null'], maxLength: 2000 },
    imageUrl: { type: ['string', 'null'], format: 'uri', maxLength: 2048 },
    bannerUrl: { type: ['string', 'null'], format: 'uri', maxLength: 2048 },
    website: { type: ['string', 'null'], format: 'uri', maxLength: 2048 },
    socialLinks: { type: ['object', 'null'] },
  },
} as const;
