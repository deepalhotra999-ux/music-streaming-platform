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
  // Phase 19 — grace period (Apple DID_FAIL_TO_RENEW / Google IN_GRACE_PERIOD).
  'SUBSCRIPTION_GRACE_PERIOD',
] as const;

export const verificationStatuses = ['UNVERIFIED', 'VERIFIED'] as const;

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
    // Phase 19 — the store product id this subscription was purchased as
    // (Apple product id / Google Play SKU), resolved from the plan mapping.
    storeProductId: { type: ['string', 'null'] },
    currentPeriodStart: { type: ['string', 'null'], format: 'date-time' },
    currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
    canceledAt: { type: ['string', 'null'], format: 'date-time' },
    verificationStatus: { type: 'string', enum: verificationStatuses },
    lastVerifiedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
} as const;

/**
 * Phase 18 — current-user subscription DTO. Omits externalSubscriptionId
 * (external transaction detail) and userId (implied: the caller). The admin
 * inspection endpoint keeps the full shape. Phase 19 adds verification
 * status and the store product id (both safe to expose to the owner).
 */
export const publicSubscriptionSchema = {
  type: 'object',
  required: ['id', 'planId', 'provider', 'status', 'verificationStatus', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    planId: { type: 'string' },
    plan: planSchema,
    provider: { type: 'string', enum: subscriptionProviders },
    status: { type: 'string', enum: subscriptionStatuses },
    storeProductId: { type: ['string', 'null'] },
    currentPeriodStart: { type: ['string', 'null'], format: 'date-time' },
    currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
    canceledAt: { type: ['string', 'null'], format: 'date-time' },
    verificationStatus: { type: 'string', enum: verificationStatuses },
    lastVerifiedAt: { type: ['string', 'null'], format: 'date-time' },
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
 * since admins inspect other users' subscriptions. Phase 19 adds
 * verification status and the store product id.
 */
export const adminSubscriptionSchema = {
  type: 'object',
  required: [
    'id',
    'userId',
    'planId',
    'provider',
    'status',
    'verificationStatus',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    planId: { type: 'string' },
    plan: planSchema,
    provider: { type: 'string', enum: subscriptionProviders },
    status: { type: 'string', enum: subscriptionStatuses },
    storeProductId: { type: ['string', 'null'] },
    currentPeriodStart: { type: ['string', 'null'], format: 'date-time' },
    currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
    canceledAt: { type: ['string', 'null'], format: 'date-time' },
    verificationStatus: { type: 'string', enum: verificationStatuses },
    lastVerifiedAt: { type: ['string', 'null'], format: 'date-time' },
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
    // Phase 19 — the most recent event, for at-a-glance inspection.
    latestEvent: {
      anyOf: [subscriptionEventSchema, { type: 'null' }],
    },
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

// --- Phase 19 — store products, purchase verification, notifications ------

/**
 * Phase 19 — purchasable store products. Derived from the plan table's
 * store-product mapping; no hard-coded product ids or prices anywhere.
 * A plan appears here only when its store product id is configured.
 */
export const storeProductSchema = {
  type: 'object',
  required: ['planCode', 'planName', 'planType', 'priceCents', 'currency', 'billingInterval'],
  properties: {
    planCode: { type: 'string' },
    planName: { type: 'string' },
    planType: { type: 'string', enum: ['INDIVIDUAL', 'FAMILY', 'STUDENT'] },
    // Billing management — pricing for the paywall. The store is the
    // source of truth at checkout; these are display values.
    priceCents: { type: 'integer' },
    currency: { type: 'string' },
    billingInterval: { type: 'string', enum: ['WEEK', 'MONTH', 'YEAR'] },
    intervalCount: { type: 'integer' },
    trialDays: { type: 'integer' },
    features: { type: 'array', items: { type: 'string' } },
    appleProductId: { type: ['string', 'null'] },
    googleProductId: { type: ['string', 'null'] },
  },
} as const;

export const storeProductsSchema = {
  type: 'object',
  required: ['products', 'appleConfigured', 'googleConfigured', 'purchasesEnabled'],
  properties: {
    products: { type: 'array', items: storeProductSchema },
    appleConfigured: { type: 'boolean' },
    googleConfigured: { type: 'boolean' },
    // Billing management — false when the purchase kill switch is off; the
    // client should hide the paywall and show existing-subscriber state.
    purchasesEnabled: { type: 'boolean' },
  },
} as const;

/**
 * Phase 19 — client purchase verification. The mobile app sends the raw
 * store transaction evidence (Apple signed-transaction JWS or transaction
 * id; Google Play purchase token). The server verifies it against the
 * store — the client callback alone never grants entitlement.
 */
export const verifyPurchaseBody = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'purchaseToken'],
  properties: {
    provider: { type: 'string', enum: ['apple', 'google'] },
    purchaseToken: { type: 'string', minLength: 1, maxLength: 8192 },
  },
} as const;

export const verifyPurchaseResultSchema = {
  type: 'object',
  required: ['subscription', 'entitlement', 'duplicate'],
  properties: {
    subscription: publicSubscriptionSchema,
    entitlement: entitlementSchema,
    duplicate: { type: 'boolean' },
  },
} as const;

/** Phase 19 — App Store Server Notifications v2 push body. */
export const appleNotificationBody = {
  type: 'object',
  additionalProperties: false,
  required: ['signedPayload'],
  properties: {
    signedPayload: { type: 'string', minLength: 1, maxLength: 65536 },
  },
} as const;

/**
 * Phase 19 — Google Pub/Sub push envelope for Real-time Developer
 * Notifications. The envelope is authenticated by the shared token in the
 * URL query string (checked in the handler, not the schema).
 */
export const googleNotificationBody = {
  type: 'object',
  additionalProperties: false,
  required: ['message'],
  properties: {
    message: {
      type: 'object',
      additionalProperties: true,
      required: ['data'],
      properties: {
        data: { type: 'string', minLength: 1 },
        messageId: { type: 'string' },
        publishTime: { type: 'string' },
      },
    },
    subscription: { type: 'string' },
  },
} as const;

export const notificationResultSchema = {
  type: 'object',
  required: ['received'],
  properties: {
    received: { type: 'boolean' },
    ignored: { type: 'boolean' },
    duplicate: { type: 'boolean' },
    eventType: { type: 'string', enum: subscriptionEventTypes },
  },
} as const;
