// Phase 15 — artist analytics & reporting. JSON schemas.
//
// Query params arrive as strings (Fastify's default ajv config does not
// coerce querystring scalars), so the schemas validate the string form and
// the service converts.

export const artistIdParamSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
    },
  },
} as const;

const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const analyticsRangeQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { type: 'string', enum: ['7d', '28d', '90d', 'all'], default: '7d' },
    trackId: { type: 'string', pattern: uuidPattern },
    albumId: { type: 'string', pattern: uuidPattern },
  },
} as const;

export const analyticsPagedQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { type: 'string', enum: ['7d', '28d', '90d', 'all'], default: '7d' },
    trackId: { type: 'string', pattern: uuidPattern },
    albumId: { type: 'string', pattern: uuidPattern },
    page: { type: 'string', pattern: '^[1-9][0-9]*$' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
} as const;

export const analyticsTrendQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { type: 'string', enum: ['7d', '28d', '90d', 'all'], default: '7d' },
    trackId: { type: 'string', pattern: uuidPattern },
    albumId: { type: 'string', pattern: uuidPattern },
    granularity: { type: 'string', enum: ['day', 'week'], default: 'day' },
  },
} as const;

export const analyticsRecentQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: { type: 'string', enum: ['7d', '28d', '90d', 'all'], default: '7d' },
    trackId: { type: 'string', pattern: uuidPattern },
    albumId: { type: 'string', pattern: uuidPattern },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
} as const;

const totalsSchema = {
  type: 'object',
  required: [
    'streams',
    'starts',
    'failedPlays',
    'incompletePlays',
    'uniqueListeners',
    'listeningTimeMs',
  ],
  properties: {
    streams: { type: 'integer', minimum: 0 },
    starts: { type: 'integer', minimum: 0 },
    failedPlays: { type: 'integer', minimum: 0 },
    incompletePlays: { type: 'integer', minimum: 0 },
    uniqueListeners: { type: 'integer', minimum: 0 },
    listeningTimeMs: { type: 'integer', minimum: 0 },
  },
} as const;

export const overviewSchema = {
  type: 'object',
  required: [
    'artistId',
    'range',
    'from',
    'to',
    'streams',
    'starts',
    'failedPlays',
    'incompletePlays',
    'uniqueListeners',
    'listeningTimeMs',
  ],
  properties: {
    artistId: { type: ['string', 'null'] },
    range: { type: 'string' },
    from: { type: ['string', 'null'] },
    to: { type: 'string' },
    ...totalsSchema.properties,
  },
} as const;

const trackStatsItemSchema = {
  type: 'object',
  required: ['trackId', 'title', ...totalsSchema.required],
  properties: {
    trackId: { type: 'string' },
    title: { type: 'string' },
    ...totalsSchema.properties,
  },
} as const;

const albumStatsItemSchema = {
  type: 'object',
  required: ['albumId', 'title', ...totalsSchema.required],
  properties: {
    albumId: { type: 'string' },
    title: { type: 'string' },
    ...totalsSchema.properties,
  },
} as const;

const trendPointSchema = {
  type: 'object',
  required: ['date', ...totalsSchema.required],
  properties: {
    date: { type: 'string' },
    ...totalsSchema.properties,
  },
} as const;

export const trendSchema = {
  type: 'object',
  required: ['granularity', 'points'],
  properties: {
    granularity: { type: 'string', enum: ['day', 'week'] },
    points: { type: 'array', items: trendPointSchema },
  },
} as const;

const recentPlaySchema = {
  type: 'object',
  required: ['sessionId', 'trackId', 'trackTitle', 'playedAt', 'listeningTimeMs'],
  properties: {
    sessionId: { type: 'string' },
    trackId: { type: 'string' },
    trackTitle: { type: 'string' },
    playedAt: { type: 'string' },
    listeningTimeMs: { type: 'integer', minimum: 0 },
  },
} as const;

export const recentSchema = {
  type: 'object',
  required: ['data'],
  properties: {
    data: { type: 'array', items: recentPlaySchema },
  },
} as const;

export { trackStatsItemSchema, albumStatsItemSchema };
