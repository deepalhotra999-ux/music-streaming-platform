// Phase 3 — authentication. Centralized, validated environment config.
// Fail fast on missing/invalid values so misconfiguration surfaces at boot,
// not on the first login attempt.

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
  /** window length in milliseconds */
  windowMs: number;
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

function parseAudioStorageDriver(raw: string | undefined): AudioStorageDriver {
  if (raw === undefined || raw === '' || raw === 'local') return 'local';
  if (raw === 's3') return 's3';
  throw new Error(`AUDIO_STORAGE_DRIVER must be "local" or "s3", got "${raw}".`);
}
