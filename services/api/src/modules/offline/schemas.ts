// Phase 25 — offline downloads. JSON Schemas for the offline endpoints.

export const authorizeDownloadBody = {
  type: 'object',
  required: ['trackId'],
  additionalProperties: false,
  properties: {
    trackId: { type: 'string', format: 'uuid' },
  },
} as const;

export const downloadAuthorizationSchema = {
  type: 'object',
  required: [
    'authorizationId',
    'token',
    'downloadTokenExpiresAt',
    'expiresAt',
    'audioVersion',
    'track',
    'downloadUrl',
  ],
  properties: {
    authorizationId: { type: 'string', format: 'uuid' },
    /** Opaque delivery token, shown exactly once. */
    token: { type: 'string', minLength: 64, maxLength: 64 },
    downloadTokenExpiresAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
    audioVersion: { type: 'integer', minimum: 1 },
    track: {
      type: 'object',
      required: ['id', 'title', 'artistName', 'durationMs'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        title: { type: 'string' },
        artistName: { type: 'string' },
        albumTitle: { type: ['string', 'null'] },
        durationMs: { type: 'integer', minimum: 0 },
      },
    },
    /** Token-scoped master playlist URL. Never permanent. */
    downloadUrl: { type: 'string' },
  },
} as const;

/** Opaque 32-byte hex download token, carried as a query param so plain
 *  HTTP download clients can fetch segments without custom headers.
 *  Invalid, expired, and revoked tokens are indistinguishable (all 401). */
export const downloadTokenQuery = {
  type: 'object',
  required: ['token'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-f]+$' },
  },
} as const;

export const authorizationIdParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export const revalidationSchema = {
  type: 'object',
  required: ['valid', 'status', 'expiresAt', 'audioVersion', 'currentAudioVersion'],
  properties: {
    valid: { type: 'boolean' },
    status: {
      type: 'string',
      enum: [
        'ok',
        'expired',
        'revoked',
        'version_mismatch',
        'entitlement_lost',
        'entitlement_canceled',
        'track_unavailable',
      ],
    },
    expiresAt: { type: 'string', format: 'date-time' },
    audioVersion: { type: 'integer', minimum: 1 },
    currentAudioVersion: { type: ['integer', 'null'] },
  },
} as const;

export const revocationSchema = {
  type: 'object',
  required: ['id', 'revokedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    revokedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const offlineEventBody = {
  type: 'object',
  required: ['events'],
  additionalProperties: false,
  properties: {
    events: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        required: ['key', 'offlineAuthorizationId', 'offlineSessionKey', 'type', 'occurredAt'],
        additionalProperties: false,
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 64 },
          offlineAuthorizationId: { type: 'string', format: 'uuid' },
          offlineSessionKey: { type: 'string', minLength: 1, maxLength: 64 },
          type: { type: 'string', enum: ['START', 'HEARTBEAT', 'COMPLETE', 'ERROR'] },
          positionMs: { type: 'integer', minimum: 0 },
          occurredAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
} as const;

export const offlineEventSyncSchema = {
  type: 'object',
  required: ['accepted', 'rejected'],
  properties: {
    accepted: { type: 'array', items: { type: 'string' } },
    rejected: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'reason'],
        properties: {
          key: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;
