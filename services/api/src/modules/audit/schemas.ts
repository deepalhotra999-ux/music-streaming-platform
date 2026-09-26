// Phase 16 — admin audit. JSON Schemas. Read-only surface: there is no
// request body schema on purpose, because no mutation endpoints exist.

export const auditEventSchema = {
  type: 'object',
  required: ['id', 'action', 'targetType', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    actorId: { type: ['string', 'null'], format: 'uuid' },
    action: { type: 'string' },
    targetType: { type: 'string' },
    targetId: { type: ['string', 'null'], format: 'uuid' },
    metadata: { type: 'object', additionalProperties: true },
    reversible: { type: 'boolean' },
    beforeState: { type: ['object', 'null'], additionalProperties: true },
    afterState: { type: ['object', 'null'], additionalProperties: true },
    reversalOf: { type: ['string', 'null'], format: 'uuid' },
    reversed: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const auditListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'string', pattern: '^[1-9][0-9]*$' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
    actorId: { type: 'string', format: 'uuid' },
    action: { type: 'string', minLength: 1, maxLength: 100 },
    targetType: { type: 'string', minLength: 1, maxLength: 100 },
    targetId: { type: 'string', format: 'uuid' },
  },
} as const;
