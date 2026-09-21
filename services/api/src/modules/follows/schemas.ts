// Phase 4 — follows. JSON Schemas for the caller's followed artists.

import { artistSummarySchema } from '../summaries.js';

export const followItemSchema = {
  type: 'object',
  required: ['artistId', 'createdAt', 'artist'],
  properties: {
    artistId: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    artist: artistSummarySchema,
  },
} as const;

export const followBody = {
  type: 'object',
  required: ['artistId'],
  additionalProperties: false,
  properties: {
    artistId: { type: 'string', format: 'uuid' },
  },
} as const;

export const artistIdParams = {
  type: 'object',
  required: ['artistId'],
  additionalProperties: false,
  properties: {
    artistId: { type: 'string', format: 'uuid' },
  },
} as const;
