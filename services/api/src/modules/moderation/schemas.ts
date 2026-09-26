// Phase 17 — moderation foundation. JSON Schemas for the admin moderation
// surface. All endpoints are ADMIN-only; LISTENER/ARTIST get 403.

export const moderationTargetTypes = [
  'ARTIST',
  'ALBUM',
  'TRACK',
  // Phase 29 — community content report targets.
  'ARTIST_POST',
  'POST_COMMENT',
] as const;
export const moderationStatuses = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'] as const;

export const moderationReportSchema = {
  type: 'object',
  required: ['id', 'targetType', 'targetId', 'reason', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    targetType: { type: 'string', enum: moderationTargetTypes },
    targetId: { type: 'string', format: 'uuid' },
    reason: { type: 'string' },
    details: { type: ['string', 'null'] },
    status: { type: 'string', enum: moderationStatuses },
    createdById: { type: ['string', 'null'], format: 'uuid' },
    reviewedById: { type: ['string', 'null'], format: 'uuid' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const createModerationReportBody = {
  type: 'object',
  additionalProperties: false,
  required: ['targetType', 'targetId', 'reason'],
  properties: {
    targetType: { type: 'string', enum: moderationTargetTypes },
    targetId: { type: 'string', format: 'uuid' },
    reason: { type: 'string', minLength: 3, maxLength: 200 },
    details: { type: 'string', maxLength: 2000 },
  },
} as const;

export const updateModerationReportBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    status: { type: 'string', enum: moderationStatuses },
    reason: { type: 'string', minLength: 3, maxLength: 200 },
    details: { type: ['string', 'null'], maxLength: 2000 },
  },
} as const;

export const moderationListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'string', pattern: '^[1-9][0-9]*$' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
    status: { type: 'string', enum: moderationStatuses },
    targetType: { type: 'string', enum: moderationTargetTypes },
    targetId: { type: 'string', format: 'uuid' },
  },
} as const;
