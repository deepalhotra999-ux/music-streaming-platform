// Phase 4 — likes. JSON Schemas for the caller's liked tracks.

import { trackSummarySchema } from '../summaries.js';

export const likeItemSchema = {
  type: 'object',
  required: ['trackId', 'createdAt', 'track'],
  properties: {
    trackId: { type: 'string', format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    track: trackSummarySchema,
  },
} as const;

export const likeBody = {
  type: 'object',
  required: ['trackId'],
  additionalProperties: false,
  properties: {
    trackId: { type: 'string', format: 'uuid' },
  },
} as const;

export const trackIdParams = {
  type: 'object',
  required: ['trackId'],
  additionalProperties: false,
  properties: {
    trackId: { type: 'string', format: 'uuid' },
  },
} as const;
