// Phase 4 — genres. Fastify (ajv) JSON Schemas for request validation and
// response serialization. Declared once, enforced at runtime.

const uuid = { type: 'string', format: 'uuid' } as const;
const page = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;
const limit = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;

export const genreSchema = {
  type: 'object',
  required: ['id', 'name', 'description', 'trackCount'],
  properties: {
    id: uuid,
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    trackCount: { type: 'integer', minimum: 0 },
  },
} as const;

export const genreListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page,
    limit,
    q: { type: 'string', maxLength: 100 },
  },
} as const;

export const createGenreBody = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: ['string', 'null'], maxLength: 500 },
  },
} as const;

export const updateGenreBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: ['string', 'null'], maxLength: 500 },
  },
} as const;
