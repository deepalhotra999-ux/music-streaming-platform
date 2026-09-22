// Phase 21 — Royalty Engine. JSON schemas for royalty endpoints.
// Money is serialized as major-unit decimal strings (e.g., "1234.56").

export const moneySchema = {
  type: 'string',
  pattern: '^-?\\d+\\.\\d{2}$',
  description: 'Major-unit decimal string, e.g. "1234.56"',
} as const;

export const artistIdParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
  additionalProperties: false,
} as const;

export const periodIdParamSchema = {
  type: 'object',
  properties: { periodId: { type: 'string', format: 'uuid' } },
  required: ['periodId'],
  additionalProperties: false,
} as const;

export const runIdParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
  additionalProperties: false,
} as const;

export const paginationQuerySchema = {
  type: 'object',
  properties: {
    page: { type: 'string', pattern: '^[0-9]+$' },
    limit: { type: 'string', pattern: '^[0-9]+$' },
  },
  additionalProperties: false,
} as const;

export const royaltyOverviewSchema = {
  type: 'object',
  properties: {
    artistId: { type: 'string', format: 'uuid' },
    currency: { type: 'string' },
    totalEarnings: moneySchema,
    totalStreams: { type: 'integer', minimum: 0 },
    completedPeriods: { type: 'integer', minimum: 0 },
    latestPeriod: {
      type: ['object', 'null'],
      properties: {
        periodId: { type: 'string', format: 'uuid' },
        periodStart: { type: 'string', format: 'date-time' },
        periodEnd: { type: 'string', format: 'date-time' },
        earnings: moneySchema,
        streams: { type: 'integer', minimum: 0 },
        runId: { type: 'string', format: 'uuid' },
        policyVersion: { type: 'integer' },
      },
      required: [
        'periodId',
        'periodStart',
        'periodEnd',
        'earnings',
        'streams',
        'runId',
        'policyVersion',
      ],
      additionalProperties: false,
    },
  },
  required: [
    'artistId',
    'currency',
    'totalEarnings',
    'totalStreams',
    'completedPeriods',
    'latestPeriod',
  ],
  additionalProperties: false,
} as const;

export const royaltyPeriodItemSchema = {
  type: 'object',
  properties: {
    periodId: { type: 'string', format: 'uuid' },
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
    status: { type: 'string', enum: ['OPEN', 'CALCULATING', 'COMPLETED', 'FAILED'] },
    currency: { type: 'string' },
    earnings: moneySchema,
    streams: { type: 'integer', minimum: 0 },
    runId: { type: ['string', 'null'], format: 'uuid' },
    policyVersion: { type: ['integer', 'null'] },
  },
  required: [
    'periodId',
    'periodStart',
    'periodEnd',
    'status',
    'currency',
    'earnings',
    'streams',
    'runId',
    'policyVersion',
  ],
  additionalProperties: false,
} as const;

export const royaltyTrackEarningSchema = {
  type: 'object',
  properties: {
    trackId: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    eligibleStreams: { type: 'integer', minimum: 0 },
    allocationPercentage: { type: 'string' },
    grossAmount: moneySchema,
    adjustmentsTotal: moneySchema,
    finalAmount: moneySchema,
    currency: { type: 'string' },
  },
  required: [
    'trackId',
    'title',
    'eligibleStreams',
    'allocationPercentage',
    'grossAmount',
    'adjustmentsTotal',
    'finalAmount',
    'currency',
  ],
  additionalProperties: false,
} as const;

export const royaltyRunSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', format: 'uuid' },
    runKey: { type: 'string' },
    periodId: { type: 'string', format: 'uuid' },
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
    policyVersion: { type: 'integer' },
    policyName: { type: 'string' },
    status: { type: 'string', enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] },
    totalEligibleStreams: { type: 'integer', minimum: 0 },
    royaltyPool: moneySchema,
    totalAllocated: moneySchema,
    residualAmount: moneySchema,
    currency: { type: 'string' },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    completedAt: { type: ['string', 'null'], format: 'date-time' },
    error: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'runId',
    'runKey',
    'periodId',
    'periodStart',
    'periodEnd',
    'policyVersion',
    'policyName',
    'status',
    'totalEligibleStreams',
    'royaltyPool',
    'totalAllocated',
    'residualAmount',
    'currency',
    'startedAt',
    'completedAt',
    'error',
    'createdAt',
  ],
  additionalProperties: false,
} as const;

/**
 * Artist-safe run detail: only the requesting artist's own totals.
 * Platform-wide pool/allocation/residual and internal runKey are NOT exposed.
 */
export const artistRoyaltyRunSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string', format: 'uuid' },
    periodId: { type: 'string', format: 'uuid' },
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
    policyVersion: { type: 'integer' },
    policyName: { type: 'string' },
    status: { type: 'string', enum: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'] },
    currency: { type: 'string' },
    startedAt: { type: ['string', 'null'], format: 'date-time' },
    completedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    artistEarnings: moneySchema,
    artistStreams: { type: 'integer', minimum: 0 },
    artistTrackCount: { type: 'integer', minimum: 0 },
  },
  required: [
    'runId',
    'periodId',
    'periodStart',
    'periodEnd',
    'policyVersion',
    'policyName',
    'status',
    'currency',
    'startedAt',
    'completedAt',
    'createdAt',
    'artistEarnings',
    'artistStreams',
    'artistTrackCount',
  ],
  additionalProperties: false,
} as const;

export const royaltyPolicySchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    version: { type: 'integer' },
    name: { type: 'string' },
    status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'RETIRED'] },
    artistPoolPercentage: { type: 'string' },
    minimumStreams: { type: ['integer', 'null'] },
    currency: { type: 'string' },
    roundingMode: { type: 'string' },
    effectiveFrom: { type: 'string', format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'version',
    'name',
    'status',
    'artistPoolPercentage',
    'minimumStreams',
    'currency',
    'roundingMode',
    'effectiveFrom',
    'createdAt',
  ],
  additionalProperties: false,
} as const;

// --- Admin write inputs ---

export const createPolicySchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    artistPoolPercentage: { type: 'string', pattern: '^\\d+(\\.\\d{1,4})?$' },
    minimumStreams: { type: ['integer', 'null'], minimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    effectiveFrom: { type: 'string', format: 'date-time' },
  },
  required: ['name', 'artistPoolPercentage', 'currency', 'effectiveFrom'],
  additionalProperties: false,
} as const;

export const activatePolicySchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export const createPeriodSchema = {
  type: 'object',
  properties: {
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  },
  required: ['periodStart', 'periodEnd'],
  additionalProperties: false,
} as const;

export const createRevenueInputSchema = {
  type: 'object',
  properties: {
    periodId: { type: 'string', format: 'uuid' },
    source: { type: 'string', minLength: 1, maxLength: 50 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    grossAmount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
    deductions: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$' },
    referenceId: { type: 'string', minLength: 1, maxLength: 200 },
    fxReference: { type: ['string', 'null'], maxLength: 200 },
  },
  required: ['periodId', 'source', 'currency', 'grossAmount', 'referenceId'],
  additionalProperties: false,
} as const;

export const triggerRunSchema = {
  type: 'object',
  properties: {
    periodId: { type: 'string', format: 'uuid' },
  },
  required: ['periodId'],
  additionalProperties: false,
} as const;
