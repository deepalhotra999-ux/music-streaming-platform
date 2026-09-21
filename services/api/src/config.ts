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
  /** window length in milliseconds */
  windowMs: number;
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
      windowMs: int(env, 'RATE_LIMIT_WINDOW_MS', 60_000),
    },
  };
}
