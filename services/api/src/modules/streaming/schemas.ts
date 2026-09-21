// Phase 7 — streaming. JSON Schemas for the playback endpoints.

export const createSessionBody = {
  type: 'object',
  required: ['trackId'],
  additionalProperties: false,
  properties: {
    trackId: { type: 'string', format: 'uuid' },
  },
} as const;

export const sessionSchema = {
  type: 'object',
  required: ['id', 'token', 'expiresAt', 'hlsUrl'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    /** Opaque session token, shown exactly once. */
    token: { type: 'string' },
    expiresAt: { type: 'string', format: 'date-time' },
    /** Session-scoped HLS master playlist URL. Never permanent. */
    hlsUrl: { type: 'string' },
  },
} as const;

/** Opaque 32-byte hex session token, carried as a query param (players fetch
 *  segments without custom headers, the same reason signed URLs use query
 *  params). Invalid and expired tokens both yield 401. */
export const sessionTokenQuery = {
  type: 'object',
  required: ['token'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]+$' },
  },
} as const;

export const renditionParams = {
  type: 'object',
  required: ['rendition'],
  additionalProperties: false,
  properties: {
    rendition: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[a-z0-9]+$' },
  },
} as const;

export const segmentParams = {
  type: 'object',
  required: ['rendition', 'segment'],
  additionalProperties: false,
  properties: {
    rendition: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[a-z0-9]+$' },
    segment: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
  },
} as const;

export const sessionIdParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export const playEventBody = {
  type: 'object',
  required: ['type'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['START', 'HEARTBEAT', 'COMPLETE', 'ERROR'] },
    positionMs: { type: 'integer', minimum: 0 },
  },
} as const;

export const playEventSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;
