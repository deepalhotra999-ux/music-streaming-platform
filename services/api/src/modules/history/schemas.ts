// Phase 4 — listening history. JSON Schemas for recording and reading the
// caller's playback history.

import { trackSummarySchema } from '../summaries.js';

export const historyItemSchema = {
  type: 'object',
  required: ['id', 'trackId', 'playedAt', 'progressMs', 'completed', 'track'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    trackId: { type: 'string', format: 'uuid' },
    playedAt: { type: 'string', format: 'date-time' },
    progressMs: { type: ['integer', 'null'] },
    completed: { type: 'boolean' },
    track: trackSummarySchema,
  },
} as const;

export const recordHistoryBody = {
  type: 'object',
  required: ['trackId'],
  additionalProperties: false,
  properties: {
    trackId: { type: 'string', format: 'uuid' },
    progressMs: { type: ['integer', 'null'], minimum: 0 },
    completed: { type: 'boolean' },
  },
} as const;
