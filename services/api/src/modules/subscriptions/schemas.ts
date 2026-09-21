// Phase 18 — subscriptions & entitlements. JSON Schemas.
//
// User surface: GET /v1/subscriptions/me, GET /v1/subscriptions/me/entitlement
// Admin surface: GET /v1/admin/users/:id/subscription
// Dev surface (DEV_SUBSCRIPTIONS_ENABLED only): POST /v1/dev/subscription-events

export const subscriptionStatuses = [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
  'CANCELED',
  'EXPIRED',
  'REVOKED',
] as const;

export const subscriptionProviders = ['APPLE', 'GOOGLE', 'DEV'] as const;

export const subscriptionEventTypes = [
  'SUBSCRIPTION_STARTED',
  'TRIAL_STARTED',
  'TRIAL_CONVERTED',
  'RENEWAL_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_RECOVERED',
  'PLAN_CHANGED',
  'SUBSCRIPTION_CANCELED',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_REVOKED',
] as const;

export const planSchema = {
  type: 'object',
  required: ['id', 'name', 'planType', 'active'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    planType: { type: 'string', enum: ['INDIVIDUAL', 'FAMILY', 'STUDENT'] },
    active: { type: 'boolean' },
  },
} as const;

export const subscriptionSchema = {
  type: 'object',
  required: ['id', 'userId', 'planId', 'provider', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    planId: { type: 'string' },
    plan: planSchema,
    provider: { type: 'string', enum: subscriptionProviders },
    status: { type: 'string', enum: subscriptionStatuses },
    // External store identifier. Opaque to clients; never a secret.
    externalSubscriptionId: { type: ['string', 'null'] },
    currentPeriodStart: { type: ['string', 'null'], format: 'date-time' },
    currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
    canceledAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * Phase 18 — current-user subscription DTO. Omits externalSubscriptionId
 * (external transaction detail) and userId (implied: the caller). The admin
 * inspection endpoint keeps the full shape.
 */
export const publicSubscriptionSchema = {
  type: 'object',
  required: ['id', 'planId', 'provider', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    planId: { type: 'string' },
    plan: planSchema,
    provider: { type: 'string', enum: subscriptionProviders },
    status: { type: 'string', enum: subscriptionStatuses },
    currentPeriodStart: { type: ['string', 'null'], format: 'date-time' },
    currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
    canceledAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const entitlementSchema = {
  type: 'object',
  required: ['entitled', 'status', 'reason'],
  properties: {
    entitled: { type: 'boolean' },
    status: { type: 'string', enum: [...subscriptionStatuses, 'NONE'] },
    planCode: { type: ['string', 'null'] },
    currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
    reason: { type: 'string' },
  },
} as const;

/**
 * Phase 18 — admin subscription DTO. Like the public DTO it omits
 * externalSubscriptionId (external transaction detail), but keeps userId
 * since admins inspect other users' subscriptions.
 */
export const adminSubscriptionSchema = {
  type: 'object',
  required: ['id', 'userId', 'planId', 'provider', 'status', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    planId: { type: 'string' },
    plan: planSchema,
    provider: { type: 'string', enum: subscriptionProviders },
    status: { type: 'string', enum: subscriptionStatuses },
    currentPeriodStart: { type: ['string', 'null'], format: 'date-time' },
    currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
    canceledAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const mySubscriptionSchema = {
  type: 'object',
  required: ['subscription', 'entitlement'],
  properties: {
    subscription: {
      anyOf: [publicSubscriptionSchema, { type: 'null' }],
    },
    entitlement: entitlementSchema,
  },
} as const;

export const subscriptionEventSchema = {
  type: 'object',
  required: ['id', 'eventType', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    eventType: { type: 'string', enum: subscriptionEventTypes },
    statusFrom: { type: ['string', 'null'], enum: [...subscriptionStatuses, null] },
    statusTo: { type: ['string', 'null'], enum: [...subscriptionStatuses, null] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const adminSubscriptionDetailSchema = {
  type: 'object',
  required: ['subscription', 'entitlement', 'events'],
  properties: {
    subscription: {
      anyOf: [adminSubscriptionSchema, { type: 'null' }],
    },
    entitlement: entitlementSchema,
    events: { type: 'array', items: subscriptionEventSchema },
  },
} as const;

/** DEV-only: deterministic provider event ingestion. */
export const devSubscriptionEventBody = {
  type: 'object',
  additionalProperties: false,
  required: ['providerEventId', 'eventType', 'externalSubscriptionId'],
  properties: {
    providerEventId: { type: 'string', minLength: 1, maxLength: 200 },
    eventType: { type: 'string', enum: subscriptionEventTypes },
    externalSubscriptionId: { type: 'string', minLength: 1, maxLength: 200 },
    planCode: { type: 'string', minLength: 1, maxLength: 100 },
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
    facts: { type: 'object', additionalProperties: { type: 'string' } },
  },
} as const;

export const devSubscriptionEventResultSchema = {
  type: 'object',
  required: ['subscription', 'entitlement', 'duplicate'],
  properties: {
    subscription: publicSubscriptionSchema,
    entitlement: entitlementSchema,
    duplicate: { type: 'boolean' },
  },
} as const;

export const userIdParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const;
