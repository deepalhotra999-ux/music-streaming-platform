// Release tooling — JSON Schemas for the deploy surface.
//
// Full property schemas everywhere (Phase 16 lesson: fast-json-stringify
// serializes bare `{ type: 'object' }` as `{}`).

export const deployBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // Branch or tag to deploy. Defaults to 'main'. Restricted to git-ref-safe
    // characters; the value travels inside a JSON payload, not a shell.
    ref: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      pattern: '^[A-Za-z0-9._/\\-]+$',
    },
  },
} as const;

export const deployResponseSchema = {
  type: 'object',
  required: ['dispatched', 'ref', 'eventType'],
  properties: {
    dispatched: { type: 'boolean' },
    ref: { type: 'string' },
    eventType: { type: 'string' },
  },
} as const;

export const deployRunSchema = {
  type: 'object',
  required: ['id', 'runNumber', 'event', 'createdAt', 'updatedAt', 'htmlUrl'],
  properties: {
    id: { type: 'number' },
    runNumber: { type: 'number' },
    name: { type: ['string', 'null'] },
    status: { type: ['string', 'null'] },
    conclusion: { type: ['string', 'null'] },
    headBranch: { type: ['string', 'null'] },
    event: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    htmlUrl: { type: 'string' },
  },
} as const;

export const deployRunsResponseSchema = {
  type: 'object',
  required: ['data'],
  properties: {
    data: { type: 'array', items: deployRunSchema },
  },
} as const;
