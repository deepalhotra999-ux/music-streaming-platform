// Phase 26 — JSON schemas for the discovery API.
//
// Follows the existing module convention: plain JSON Schema objects consumed
// by Fastify route validation. Responses use safe DTOs: IDs + display
// metadata + truthful reasons + policy metadata. Internal ranking weights
// and private behavioral features are never exposed.

export const discoveryConstraintsSchema = {
  type: 'object',
  properties: {
    genreIds: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    artistIds: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    moods: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    energy: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    tempoBpm: { type: ['number', 'null'], minimum: 40, maximum: 220 },
    era: { type: ['string', 'null'], maxLength: 12 },
    emergingOnly: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    exploration: { type: 'number', minimum: 0, maximum: 1 },
  },
  additionalProperties: false,
} as const;

export const recommendationsQuerySchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    genreId: { type: 'string' },
    artistId: { type: 'string' },
    emergingOnly: { type: 'boolean' },
    refresh: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

export const discoveryQueryBodySchema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
} as const;

export const playlistCriteriaBodySchema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 500 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    name: { type: 'string', minLength: 1, maxLength: 120 },
  },
  additionalProperties: false,
} as const;

const trackDtoSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    durationMs: { type: 'integer' },
    artist: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['id', 'name'],
    },
    album: {
      type: ['object', 'null'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['id', 'title'],
    },
  },
  required: ['id', 'title', 'durationMs', 'artist', 'album'],
} as const;

export const recommendationResponseSchema = {
  type: 'object',
  properties: {
    requestId: { type: 'string' },
    policy: {
      type: 'object',
      properties: {
        policyVersion: { type: 'string' },
        personalized: { type: 'boolean' },
        aiProvider: { type: 'string' },
      },
      required: ['policyVersion', 'personalized', 'aiProvider'],
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          track: trackDtoSchema,
          reason: { type: 'string' },
          reasonKind: { type: 'string' },
        },
        required: ['track', 'reason', 'reasonKind'],
      },
    },
    candidateCount: { type: 'integer' },
    generatedAt: { type: 'string' },
  },
  required: ['requestId', 'policy', 'items', 'candidateCount', 'generatedAt'],
} as const;

export const emergingArtistsResponseSchema = {
  type: 'object',
  properties: {
    artists: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          artistId: { type: 'string' },
          artistName: { type: 'string' },
          recentStreams: { type: 'integer' },
        },
        required: ['artistId', 'artistName', 'recentStreams'],
      },
    },
  },
  required: ['artists'],
} as const;

export const playlistCriteriaResponseSchema = {
  type: 'object',
  properties: {
    requestId: { type: 'string' },
    criteria: discoveryConstraintsSchema,
    items: recommendationResponseSchema.properties.items,
    aiProvider: { type: 'string' },
  },
  required: ['requestId', 'criteria', 'items', 'aiProvider'],
} as const;
