// Admin governance — JSON Schemas.

const uuidParam = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export const adminAccountSchema = {
  type: 'object',
  required: [
    'id',
    'email',
    'displayName',
    'role',
    'bundlePermissions',
    'grantedPermissions',
    'effectivePermissions',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    displayName: { type: 'string' },
    role: {
      type: 'string',
      enum: [
        'SUPER_ADMIN',
        'ADMIN',
        'PLATFORM_ADMIN',
        'MODERATOR',
        'SUPPORT_ADMIN',
        'FINANCE_ADMIN',
        'CONTENT_ADMIN',
        'ARTIST_ADMIN',
        'ANALYTICS_ADMIN',
      ],
    },
    bundlePermissions: { type: 'array', items: { type: 'string' } },
    grantedPermissions: { type: 'array', items: { type: 'string' } },
    effectivePermissions: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const roleCatalogSchema = {
  type: 'object',
  required: ['roles', 'permissions', 'assignableRoles'],
  properties: {
    roles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'bundlePermissions'],
        properties: {
          role: { type: 'string' },
          bundlePermissions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    permissions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'description'],
        properties: {
          key: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
    assignableRoles: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const grantPermissionsBody = {
  type: 'object',
  required: ['permissions'],
  additionalProperties: false,
  properties: {
    permissions: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 64 },
      maxItems: 32,
    },
  },
} as const;

export const banBody = {
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 3, maxLength: 500 },
    durationDays: { type: 'integer', minimum: 1, maximum: 3650 },
  },
} as const;

export const updateEmailBody = {
  type: 'object',
  required: ['email'],
  additionalProperties: false,
  properties: { email: { type: 'string', format: 'email', maxLength: 320 } },
} as const;

export const resetPasswordBody = {
  type: 'object',
  required: ['newPassword'],
  additionalProperties: false,
  // Same policy as registration: 12..128 chars.
  properties: { newPassword: { type: 'string', minLength: 12, maxLength: 128 } },
} as const;

export const sessionSchema = {
  type: 'object',
  required: ['id', 'createdAt', 'expiresAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    ipAddress: { type: ['string', 'null'] },
    userAgent: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const loginEventSchema = {
  type: 'object',
  required: ['id', 'email', 'success', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    ipAddress: { type: ['string', 'null'] },
    userAgent: { type: ['string', 'null'] },
    success: { type: 'boolean' },
    failureReason: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const updateSubscriptionBody = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 100 },
    status: {
      type: 'string',
      enum: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'REVOKED'],
    },
    currentPeriodStart: { type: 'string', format: 'date-time' },
    currentPeriodEnd: { type: 'string', format: 'date-time' },
  },
} as const;

export const setTrialBody = {
  type: 'object',
  required: ['trialing'],
  additionalProperties: false,
  properties: { trialing: { type: 'boolean' } },
} as const;

export const chargebackBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    providerRef: { type: 'string', maxLength: 200 },
    amountCents: { type: 'integer', minimum: 0 },
    currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
    reason: { type: 'string', minLength: 3, maxLength: 500 },
  },
} as const;

export const chargebackSchema = {
  type: 'object',
  required: ['id', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    providerRef: { type: ['string', 'null'] },
    amountCents: { type: ['integer', 'null'] },
    currency: { type: ['string', 'null'] },
    reason: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const reversalResultSchema = {
  type: 'object',
  required: ['reversedAction', 'restoredSummary'],
  properties: {
    reversedAction: { type: 'string' },
    restoredSummary: { type: 'object', additionalProperties: true },
  },
} as const;

export const paginationQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'string', pattern: '^[1-9][0-9]*$' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
} as const;

export { uuidParam };
