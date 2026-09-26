// Phase 3 — authentication. Centralized, validated environment config.
// Fail fast on missing/invalid values so misconfiguration surfaces at boot,
// not on the first login attempt.

import { readFileSync } from 'node:fs';

export interface RateLimitConfig {
  /** requests per window, per IP */
  login: number;
  register: number;
  refresh: number;
  logout: number;
  /** general API routes (all Phase 4 endpoints) */
  api: number;
  /** HLS manifest/segment delivery — generous: a player fetches many segments */
  streaming: number;
  /** Phase 25 — download authorization issuance. Tight: authorizations are
   *  cheap to request but must not be farmable in bulk. */
  offlineAuthorize: number;
  /** Phase 28 — room creation. Bounded per user: rooms are cheap but
   *  spamming them pollutes the namespace. */
  roomsCreate: number;
  /** Phase 28 — room join attempts. Tight enough to make invitation-token
   *  probing infeasible; generous enough for legitimate retries. */
  roomsJoin: number;
  /** Phase 28 — invitation issuance per user. */
  roomsInvite: number;
  /** Phase 29 — community write buckets. Per USER (authenticated server
   *  identity), not per IP: a malicious client cannot dodge them by
   *  rotating IPs, and shared-NAT users do not share a budget. */
  communityPostCreate: number;
  communityPostEdit: number;
  communityCommentCreate: number;
  communityReaction: number;
  communityReport: number;
  /** Phase 30 — commerce write buckets. Per USER (authenticated server
   *  identity), not per IP. */
  commerceStoreCreate: number;
  commerceProductCreate: number;
  commerceVariantCreate: number;
  commerceCartMutate: number;
  commerceCheckout: number;
  commerceRefundRequest: number;
  commerceProductReport: number;
  /** window length in milliseconds */
  windowMs: number;
}

/** Phase 29 — artist/fan community tunables. */
export interface CommunityConfig {
  /** Maximum post body length in characters. */
  postMaxLength: number;
  /** Maximum comment body length in characters. */
  commentMaxLength: number;
  /** Identical posts by the same author inside this window are rejected. */
  duplicateWindowMs: number;
}

/** Phase 30 — artist commerce tunables. */
export interface CommerceConfig {
  /**
   * Payment provider id. 'mock' is the deterministic development/test
   * adapter and is rejected outside development/test (see parse below).
   * Production providers (e.g. 'stripe') are future integration boundaries:
   * selecting one without a configured adapter fails fast at startup.
   */
  paymentProvider: string;
  /**
   * Shared secret the mock provider uses to sign its webhook payloads.
   * Demonstrates the signature-verification pattern; it is NOT a real
   * payment credential and must never be treated as one.
   */
  mockWebhookSecret: string;
  /** Maximum store name length in characters. */
  storeNameMaxLength: number;
  /** Maximum store description length in characters. */
  storeDescriptionMaxLength: number;
  /** Maximum product title length in characters. */
  productTitleMaxLength: number;
  /** Maximum product description length in characters. */
  productDescriptionMaxLength: number;
  /** Maximum variants per product. */
  maxVariantsPerProduct: number;
  /** Maximum quantity per cart line. */
  maxCartLineQuantity: number;
}

/** Where audio bytes come from. 'local' is the development default and needs
 *  no AWS configuration; 's3' uses the private-bucket driver (Phase 14) and
 *  fails fast at startup when S3_BUCKET is unset. */
export type AudioStorageDriver = 'local' | 's3';

export interface S3Config {
  /** S3 bucket holding audio. Null when S3_BUCKET is unset. */
  bucket: string | null;
  /** AWS region. Defaults to ca-central-1 per project infrastructure. */
  region: string;
  /** Optional key prefix inside the bucket (no leading/trailing slashes). */
  prefix: string;
}

export interface StreamingConfig {
  audioStorageDriver: AudioStorageDriver;
  /** Local driver: directory holding per-track HLS packages. Relative paths
   *  resolve from the API process working directory. */
  audioStorageDir: string;
  /** Lifetime of a playback session token, in seconds. */
  playbackSessionTtlSeconds: number;
  s3: S3Config;
}

/** Phase 25 — offline downloads & offline playback. */
export interface OfflineConfig {
  /** Lifetime of a download delivery token, in seconds. The token only
   *  fetches HLS segments; it is discarded after the download completes. */
  downloadTokenTtlSeconds: number;
  /** Offline entitlement window, in seconds. Offline playback is allowed
   *  only inside [issuedAt, expiresAt]; the window slides forward on
   *  successful server-side revalidation while the user stays entitled. */
  authorizationTtlSeconds: number;
}

/** Phase 26 — AI music discovery & recommendations. */
export interface DiscoveryConfig {
  /** NL query endpoint rate limit (requests per window). Tight: each call
   *  may invoke an AI provider. */
  queryRateLimit: number;
  /** Window length in milliseconds for the discovery query bucket. */
  queryRateLimitWindowMs: number;
  /** Recommendation cache TTL, in milliseconds. Short: taste signals
   *  change and cached results go stale quickly. */
  cacheTtlMs: number;
  /** AI provider selection: "none" (default, deterministic local parsing)
   *  or a vendor name. Unknown values fall back to "none". */
  aiProvider: string;
  /** AI request timeout, in milliseconds. */
  aiTimeoutMs: number;
}

/** Phase 14 — artist audio ingestion (upload + transcode pipeline). */
export interface IngestionConfig {
  /** Maximum accepted upload size in bytes. Enforced while streaming the
   *  request body; the temp file is discarded when exceeded. */
  maxUploadBytes: number;
}

/** Phase 18 — subscriptions & entitlements. */
export interface SubscriptionsConfig {
  /**
   * DEV_SUBSCRIPTIONS_ENABLED=true exposes the deterministic dev
   * subscription adapter and the POST /v1/dev/subscription-events
   * endpoint. Must never be true in production — loadConfig throws.
   */
  devEnabled: boolean;
  /** Phase 19 — Apple App Store server integration. */
  apple: AppleStoreConfig;
  /** Phase 19 — Google Play server integration. */
  google: GooglePlayConfig;
}

/**
 * Phase 19 — Apple App Store server integration config. All values come
 * from the environment (see .env.example); nothing is hard-coded. The
 * integration is disabled unless every required value is present, so
 * developers without store credentials can still run the project.
 */
export interface AppleStoreConfig {
  /** True when all required Apple credentials are configured. */
  enabled: boolean;
  /** 'sandbox' (default) or 'production' — selects the App Store Server API host. */
  environment: 'sandbox' | 'production';
  /** App's bundle ID (e.g. com.musicstreaming.waveform). */
  bundleId: string | null;
  /** App Store Connect API key ID (10-char). */
  keyId: string | null;
  /** App Store Connect API issuer ID (UUID). */
  issuerId: string | null;
  /** ES256 private key PEM for App Store Server API JWTs. Never logged. */
  privateKeyPem: string | null;
}

/**
 * Phase 19 — Google Play server integration config. All values come from
 * the environment; the integration is disabled unless configured.
 */
export interface GooglePlayConfig {
  /** True when the service account and package name are configured. */
  enabled: boolean;
  /** Android application package (e.g. com.musicstreaming.waveform). */
  packageName: string | null;
  /** Service-account JSON (inline or file path). Never logged. */
  serviceAccountJson: string | null;
  /**
   * Shared secret appended as ?token= to the Pub/Sub push endpoint URL.
   * Google echoes it back so the endpoint can reject forged pushes.
   */
  pubsubVerificationToken: string | null;
}

export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  rateLimits: RateLimitConfig;
  streaming: StreamingConfig;
  ingestion: IngestionConfig;
  subscriptions: SubscriptionsConfig;
  /** Phase 25 — offline downloads & offline playback. */
  offline: OfflineConfig;
  /** Phase 26 — AI music discovery & recommendations. */
  discovery: DiscoveryConfig;
  /** Phase 29 — artist/fan community. */
  community: CommunityConfig;
  /** Phase 30 — artist commerce. */
  commerce: CommerceConfig;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} is required. Set it in the environment or services/api/.env (see .env.example).`,
    );
  }
  return value;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = required(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error(
      'JWT_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48',
    );
  }

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port: int(env, 'PORT', 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER ?? 'music-streaming',
    jwtAudience: env.JWT_AUDIENCE ?? 'music-streaming-api',
    accessTokenTtlSeconds: int(env, 'ACCESS_TOKEN_TTL_SECONDS', 900), // 15 min
    refreshTokenTtlSeconds: int(env, 'REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 3600), // 30 days
    rateLimits: {
      login: int(env, 'RATE_LIMIT_LOGIN', 10),
      register: int(env, 'RATE_LIMIT_REGISTER', 20),
      refresh: int(env, 'RATE_LIMIT_REFRESH', 60),
      logout: int(env, 'RATE_LIMIT_LOGOUT', 60),
      api: int(env, 'RATE_LIMIT_API', 300),
      streaming: int(env, 'RATE_LIMIT_STREAMING', 600),
      offlineAuthorize: int(env, 'RATE_LIMIT_OFFLINE_AUTHORIZE', 60),
      roomsCreate: int(env, 'RATE_LIMIT_ROOMS_CREATE', 10),
      roomsJoin: int(env, 'RATE_LIMIT_ROOMS_JOIN', 30),
      roomsInvite: int(env, 'RATE_LIMIT_ROOMS_INVITE', 20),
      communityPostCreate: int(env, 'RATE_LIMIT_COMMUNITY_POST_CREATE', 10),
      communityPostEdit: int(env, 'RATE_LIMIT_COMMUNITY_POST_EDIT', 30),
      communityCommentCreate: int(env, 'RATE_LIMIT_COMMUNITY_COMMENT_CREATE', 30),
      communityReaction: int(env, 'RATE_LIMIT_COMMUNITY_REACTION', 100),
      communityReport: int(env, 'RATE_LIMIT_COMMUNITY_REPORT', 20),
      commerceStoreCreate: int(env, 'RATE_LIMIT_COMMERCE_STORE_CREATE', 5),
      commerceProductCreate: int(env, 'RATE_LIMIT_COMMERCE_PRODUCT_CREATE', 30),
      commerceVariantCreate: int(env, 'RATE_LIMIT_COMMERCE_VARIANT_CREATE', 120),
      commerceCartMutate: int(env, 'RATE_LIMIT_COMMERCE_CART_MUTATE', 120),
      commerceCheckout: int(env, 'RATE_LIMIT_COMMERCE_CHECKOUT', 20),
      commerceRefundRequest: int(env, 'RATE_LIMIT_COMMERCE_REFUND_REQUEST', 20),
      commerceProductReport: int(env, 'RATE_LIMIT_COMMERCE_PRODUCT_REPORT', 20),
      windowMs: int(env, 'RATE_LIMIT_WINDOW_MS', 60_000),
    },
    streaming: {
      audioStorageDriver: parseAudioStorageDriver(env.AUDIO_STORAGE_DRIVER),
      audioStorageDir: env.AUDIO_STORAGE_DIR ?? './storage/audio',
      playbackSessionTtlSeconds: int(env, 'PLAYBACK_SESSION_TTL_SECONDS', 900), // 15 min
      s3: {
        bucket: env.S3_BUCKET ?? null,
        region: env.S3_REGION ?? 'ca-central-1',
        prefix: (env.S3_PREFIX ?? '').replace(/^\/+|\/+$/g, ''),
      },
    },
    ingestion: {
      maxUploadBytes: int(env, 'INGESTION_MAX_UPLOAD_BYTES', 100 * 1024 * 1024), // 100 MiB
    },
    subscriptions: {
      devEnabled: parseDevSubscriptions(env),
      apple: parseAppleStore(env),
      google: parseGooglePlay(env),
    },
    offline: {
      downloadTokenTtlSeconds: int(env, 'OFFLINE_DOWNLOAD_TOKEN_TTL_SECONDS', 3600), // 1 hour
      authorizationTtlSeconds: int(env, 'OFFLINE_AUTHORIZATION_TTL_SECONDS', 30 * 24 * 3600), // 30 days
    },
    discovery: {
      queryRateLimit: int(env, 'DISCOVERY_QUERY_RATE_LIMIT', 30),
      queryRateLimitWindowMs: int(env, 'DISCOVERY_QUERY_RATE_LIMIT_WINDOW_MS', 60_000),
      cacheTtlMs: int(env, 'DISCOVERY_CACHE_TTL_MS', 5 * 60 * 1000), // 5 min
      aiProvider: (env.DISCOVERY_AI_PROVIDER ?? 'none').toLowerCase(),
      aiTimeoutMs: int(env, 'DISCOVERY_AI_TIMEOUT_MS', 8000),
    },
    community: {
      postMaxLength: int(env, 'COMMUNITY_POST_MAX_LENGTH', 2000),
      commentMaxLength: int(env, 'COMMUNITY_COMMENT_MAX_LENGTH', 500),
      duplicateWindowMs: int(env, 'COMMUNITY_DUPLICATE_WINDOW_MS', 5 * 60 * 1000), // 5 min
    },
    commerce: {
      paymentProvider: parseCommercePaymentProvider(env),
      mockWebhookSecret: env.COMMERCE_MOCK_WEBHOOK_SECRET ?? 'dev-mock-webhook-secret-change-me',
      storeNameMaxLength: int(env, 'COMMERCE_STORE_NAME_MAX_LENGTH', 80),
      storeDescriptionMaxLength: int(env, 'COMMERCE_STORE_DESCRIPTION_MAX_LENGTH', 2000),
      productTitleMaxLength: int(env, 'COMMERCE_PRODUCT_TITLE_MAX_LENGTH', 120),
      productDescriptionMaxLength: int(env, 'COMMERCE_PRODUCT_DESCRIPTION_MAX_LENGTH', 5000),
      maxVariantsPerProduct: int(env, 'COMMERCE_MAX_VARIANTS_PER_PRODUCT', 50),
      maxCartLineQuantity: int(env, 'COMMERCE_MAX_CART_LINE_QUANTITY', 99),
    },
  };
}

function parseDevSubscriptions(env: NodeJS.ProcessEnv): boolean {
  const enabled = env.DEV_SUBSCRIPTIONS_ENABLED === 'true';
  if (enabled && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    // The dev adapter performs NO store verification; it must be
    // impossible to enable outside local development and tests.
    throw new Error(
      'DEV_SUBSCRIPTIONS_ENABLED may only be true when NODE_ENV is development or test.',
    );
  }
  return enabled;
}

/**
 * Phase 30 — payment provider selection. The mock adapter performs NO real
 * payment processing and must be impossible to select outside local
 * development and tests. Selecting a real provider id without a configured
 * adapter fails fast at startup so production can never silently run on
 * the mock.
 */
function parseCommercePaymentProvider(env: NodeJS.ProcessEnv): string {
  const raw = (env.COMMERCE_PAYMENT_PROVIDER ?? 'mock').toLowerCase();
  if (raw === 'mock') {
    if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
      throw new Error(
        'COMMERCE_PAYMENT_PROVIDER=mock may only be used when NODE_ENV is development or test.',
      );
    }
    return 'mock';
  }
  // Future provider ids (e.g. 'stripe') are recognized so configuration is
  // explicit, but no adapter is implemented in Phase 30.
  throw new Error(
    `COMMERCE_PAYMENT_PROVIDER="${raw}" has no configured adapter in Phase 30. ` +
      'Only "mock" is implemented; a production provider requires a new adapter implementation.',
  );
}

function parseAudioStorageDriver(raw: string | undefined): AudioStorageDriver {
  if (raw === undefined || raw === '' || raw === 'local') return 'local';
  if (raw === 's3') return 's3';
  throw new Error(`AUDIO_STORAGE_DRIVER must be "local" or "s3", got "${raw}".`);
}

/**
 * Phase 19 — Apple App Store server config. The private key may be given
 * inline (APPLE_PRIVATE_KEY, with literal \n escapes) or as a file path
 * (APPLE_PRIVATE_KEY_PATH). Missing values disable the integration rather
 * than failing startup, so developers without store credentials can run.
 */
function parseAppleStore(env: NodeJS.ProcessEnv): AppleStoreConfig {
  const environment = env.APPLE_ENVIRONMENT ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`APPLE_ENVIRONMENT must be "sandbox" or "production", got "${environment}".`);
  }
  const bundleId = env.APPLE_BUNDLE_ID ?? null;
  const keyId = env.APPLE_KEY_ID ?? null;
  const issuerId = env.APPLE_ISSUER_ID ?? null;
  let privateKeyPem: string | null = null;
  if (env.APPLE_PRIVATE_KEY) {
    privateKeyPem = env.APPLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  } else if (env.APPLE_PRIVATE_KEY_PATH) {
    // Read lazily at startup; a missing file disables the integration.
    try {
      privateKeyPem = readFileSync(env.APPLE_PRIVATE_KEY_PATH, 'utf8');
    } catch {
      privateKeyPem = null;
    }
  }
  const enabled = Boolean(bundleId && keyId && issuerId && privateKeyPem);
  return { enabled, environment, bundleId, keyId, issuerId, privateKeyPem };
}

/**
 * Phase 19 — Google Play server config. The service account may be given
 * inline (GOOGLE_SERVICE_ACCOUNT_JSON) or as a file path
 * (GOOGLE_SERVICE_ACCOUNT_JSON_PATH). Missing values disable the
 * integration rather than failing startup.
 */
function parseGooglePlay(env: NodeJS.ProcessEnv): GooglePlayConfig {
  const packageName = env.GOOGLE_PACKAGE_NAME ?? null;
  let serviceAccountJson: string | null = null;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    serviceAccountJson = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  } else if (env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH) {
    try {
      serviceAccountJson = readFileSync(env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH, 'utf8');
    } catch {
      serviceAccountJson = null;
    }
  }
  const pubsubVerificationToken = env.GOOGLE_PUBSUB_VERIFICATION_TOKEN ?? null;
  const enabled = Boolean(packageName && serviceAccountJson);
  return { enabled, packageName, serviceAccountJson, pubsubVerificationToken };
}
