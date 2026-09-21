// Phase 14 — artist audio ingestion. Response/request schemas.

export const audioStatusSchema = {
  type: 'object',
  required: ['trackId', 'audioStatus', 'audioError', 'audioReadyAt'],
  properties: {
    trackId: { type: 'string', format: 'uuid' },
    audioStatus: {
      type: 'string',
      enum: ['NONE', 'PENDING', 'PROCESSING', 'READY', 'FAILED'],
    },
    audioError: { type: ['string', 'null'] },
    audioReadyAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

export const trackIdParamSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;
