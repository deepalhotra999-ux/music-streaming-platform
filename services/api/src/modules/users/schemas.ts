// Phase 4 — users. JSON Schemas. Reuses the auth module's publicUserSchema
// so the user shape is identical everywhere it appears.

import { publicUserSchema } from '../auth/schemas.js';

export { publicUserSchema };

/**
 * Public profile for GET /v1/users/:id. Email is only present when the
 * viewer is the user themselves or an admin (see service).
 */
export const userProfileSchema = {
  type: 'object',
  required: ['id', 'displayName', 'avatarUrl', 'role', 'countryCode', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    displayName: { type: 'string' },
    avatarUrl: { type: ['string', 'null'] },
    role: { type: 'string', enum: ['LISTENER', 'ARTIST', 'ADMIN'] },
    countryCode: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const updateMeBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
    avatarUrl: { type: ['string', 'null'], format: 'uri', maxLength: 2048 },
    countryCode: { type: ['string', 'null'], pattern: '^[A-Za-z]{2}$' },
  },
} as const;

export const updateRoleBody = {
  type: 'object',
  required: ['role'],
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['LISTENER', 'ARTIST', 'ADMIN'] },
  },
} as const;

export const userListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'string', pattern: '^[1-9][0-9]*$' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
    q: { type: 'string', minLength: 1, maxLength: 100 },
    role: { type: 'string', enum: ['LISTENER', 'ARTIST', 'ADMIN'] },
  },
} as const;
