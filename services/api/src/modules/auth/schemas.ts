// Phase 3 — authentication. Fastify (ajv) JSON Schemas for request
// validation and response serialization. Declared once, enforced at runtime.

const email = { type: 'string', format: 'email', maxLength: 254 } as const;
const password = { type: 'string', minLength: 12, maxLength: 128 } as const;
const refreshTokenField = { type: 'string', minLength: 43, maxLength: 44 } as const;

export const registerBody = {
  type: 'object',
  required: ['email', 'password', 'displayName'],
  additionalProperties: false,
  properties: {
    email,
    password,
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const;

export const loginBody = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email,
    // Login accepts any non-empty password: the policy (min 12) applies at
    // registration, and wrong passwords must fail closed as 401 either way.
    password: { type: 'string', minLength: 1, maxLength: 128 },
  },
} as const;

export const refreshBody = {
  type: 'object',
  required: ['refreshToken'],
  additionalProperties: false,
  properties: { refreshToken: refreshTokenField },
} as const;

export const logoutBody = refreshBody;

export const publicUserSchema = {
  type: 'object',
  required: [
    'id',
    'email',
    'displayName',
    'avatarUrl',
    'role',
    'emailVerified',
    'countryCode',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    displayName: { type: 'string' },
    avatarUrl: { type: ['string', 'null'] },
    role: { type: 'string', enum: ['LISTENER', 'ARTIST', 'ADMIN', 'SUPER_ADMIN', 'PLATFORM_ADMIN', 'MODERATOR', 'SUPPORT_ADMIN', 'FINANCE_ADMIN', 'CONTENT_ADMIN', 'ARTIST_ADMIN', 'ANALYTICS_ADMIN'] },
    emailVerified: { type: 'boolean' },
    countryCode: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' },
    // Phase 17 — account status for the admin console. Null = active.
    deletedAt: { type: ['string', 'null'], format: 'date-time' },
  },
} as const;

export const tokenPairSchema = {
  type: 'object',
  required: ['tokenType', 'accessToken', 'refreshToken', 'expiresIn'],
  properties: {
    tokenType: { type: 'string', const: 'Bearer' },
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
    expiresIn: { type: 'number' },
  },
} as const;

export const authResultSchema = {
  type: 'object',
  required: ['user', 'tokens'],
  properties: {
    user: publicUserSchema,
    tokens: tokenPairSchema,
  },
} as const;
