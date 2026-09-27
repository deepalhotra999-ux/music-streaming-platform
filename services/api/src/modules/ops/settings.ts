// Admin V2 — platform settings, feature flags, and emergency controls.
//
// Platform settings are strongly typed: every key has a server-side
// definition (type, default, validator). Unknown keys are rejected; values
// outside the allowed range are rejected. Emergency keys
// (`emergency.maintenance_mode`, `emergency.readonly_mode`,
// `emergency.new_signups_enabled`) are break-glass controls enforced by the
// HTTP layer (see http/auth.ts and http/app.ts). Only SUPER_ADMIN can change
// settings or flags; every change is audited with before/after values.
//
// Feature flags are simple gated rollouts: `enabled` + `rolloutPercent`.
// They carry no code or config execution — the API only stores the desired
// state; clients/servers decide what to do with it.

import { prisma } from '../../db.js';
import type { PrismaClient } from '@prisma/client';

type Db = PrismaClient;

export type SettingType = 'boolean' | 'integer' | 'string';

export interface SettingDefinition {
  type: SettingType;
  default: boolean | number | string;
  description: string;
  /** Inclusive bounds for integers. */
  min?: number;
  max?: number;
  /** Max length for strings. */
  maxLength?: number;
  /** Extra validation; return an error message or null when valid. */
  validate?: (value: unknown) => string | null;
}

export const SETTING_DEFINITIONS: Record<string, SettingDefinition> = {
  'emergency.maintenance_mode': {
    type: 'boolean',
    default: false,
    description:
      'Break-glass: when true, every non-admin request is answered 503 ' +
      '(admin routes, login, and health checks stay reachable so the platform can be recovered).',
  },
  'emergency.readonly_mode': {
    type: 'boolean',
    default: false,
    description:
      'Break-glass: when true, non-admin clients cannot mutate anything ' +
      '(writes return 403); reads keep working.',
  },
  'emergency.new_signups_enabled': {
    type: 'boolean',
    default: true,
    description: 'Kill switch for new user registration.',
  },
  'billing.subscriptions_enabled': {
    type: 'boolean',
    default: true,
    description:
      'Kill switch for new subscription purchases. When false, purchase ' +
      'verification returns 503; existing subscribers and store webhooks are ' +
      'unaffected.',
  },
  'billing.grace_period_days': {
    type: 'integer',
    default: 3,
    min: 0,
    max: 30,
    description:
      'Days a PAST_DUE subscription keeps premium access after the paid ' +
      'period ends, before entitlement is cut. 0 disables the grace window.',
  },
  'platform.maintenance_message': {
    type: 'string',
    default: 'The platform is undergoing maintenance. Please try again shortly.',
    description: 'Message shown to clients while maintenance mode is active.',
    maxLength: 500,
  },
  'platform.support_email': {
    type: 'string',
    default: '',
    description: 'Public support contact shown in the admin console. Optional.',
    maxLength: 320,
    validate: (v) =>
      v === '' || (typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
        ? null
        : 'Must be a valid email address or empty.',
  },
};

export function isKnownSetting(key: string): key is keyof typeof SETTING_DEFINITIONS {
  return key in SETTING_DEFINITIONS;
}

/** Validate a raw JSON value against the key's definition. Throws 400-style Error. */
export function validateSettingValue(key: string, value: unknown): void {
  const def = SETTING_DEFINITIONS[key];
  if (!def) {
    throw Object.assign(new Error(`Unknown setting key: ${key}.`), { statusCode: 400 });
  }
  const fail = (msg: string): never => {
    throw Object.assign(new Error(`Invalid value for ${key}: ${msg}`), { statusCode: 400 });
  };
  if (def.type === 'boolean' && typeof value !== 'boolean') fail('expected a boolean.');
  if (def.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) fail('expected an integer.');
    if (def.min !== undefined && (value as number) < def.min) fail(`must be >= ${def.min}.`);
    if (def.max !== undefined && (value as number) > def.max) fail(`must be <= ${def.max}.`);
  }
  if (def.type === 'string') {
    if (typeof value !== 'string') fail('expected a string.');
    if (def.maxLength !== undefined && (value as string).length > def.maxLength) {
      fail(`must be at most ${def.maxLength} characters.`);
    }
  }
  if (def.validate) {
    const msg = def.validate(value);
    if (msg) fail(msg);
  }
}

// ---------------------------------------------------------------------------
// Cached reads for the request hot path (auth hooks). Refreshed lazily: at
// most one DB read per CACHE_TTL_MS, plus an explicit refresh after writes.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
let cache: Map<string, unknown> | null = null;
let cacheAt = 0;

async function loadCache(db: Db): Promise<Map<string, unknown>> {
  const rows = await db.platformSetting.findMany();
  const map = new Map<string, unknown>();
  for (const [key, def] of Object.entries(SETTING_DEFINITIONS)) {
    map.set(key, def.default);
  }
  for (const row of rows) {
    if (isKnownSetting(row.key)) map.set(row.key, row.value as unknown);
  }
  return map;
}

export async function refreshSettingsCache(db: Db = prisma): Promise<void> {
  cache = await loadCache(db);
  cacheAt = Date.now();
}

async function cachedSettings(db: Db = prisma): Promise<Map<string, unknown>> {
  if (!cache || Date.now() - cacheAt > CACHE_TTL_MS) {
    try {
      cache = await loadCache(db);
      cacheAt = Date.now();
    } catch {
      // Fail closed for reads: if the DB is unreachable, fall back to the
      // last known cache, or safe defaults when there is none. Emergency
      // states therefore persist through a DB blip rather than silently
      // clearing.
      if (!cache) {
        cache = new Map(Object.entries(SETTING_DEFINITIONS).map(([k, d]) => [k, d.default]));
        cacheAt = Date.now();
      }
    }
  }
  return cache;
}

/** Hot-path check used by auth hooks. Never throws. */
export async function emergencyActive(key: string): Promise<boolean> {
  try {
    const map = await cachedSettings();
    return map.get(key) === true;
  } catch {
    return false;
  }
}

/**
 * Billing management — typed read of a known setting. Never throws;
 * returns the definition default when the DB is unreachable.
 */
export async function getSettingValue<T>(key: string, db: Db = prisma): Promise<T> {
  const def = SETTING_DEFINITIONS[key];
  try {
    const map = await cachedSettings(db);
    const v = map.get(key);
    return (v === undefined ? def?.default : v) as T;
  } catch {
    return def?.default as T;
  }
}

export async function getMaintenanceMessage(): Promise<string> {
  try {
    const map = await cachedSettings();
    const v = map.get('platform.maintenance_message');
    return typeof v === 'string' && v.length > 0
      ? v
      : String(SETTING_DEFINITIONS['platform.maintenance_message'].default);
  } catch {
    return String(SETTING_DEFINITIONS['platform.maintenance_message'].default);
  }
}

export interface SettingDto {
  key: string;
  value: boolean | number | string;
  type: SettingType;
  default: boolean | number | string;
  description: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export async function listSettings(db: Db = prisma): Promise<SettingDto[]> {
  const rows = await db.platformSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return Object.entries(SETTING_DEFINITIONS).map(([key, def]) => {
    const row = byKey.get(key);
    return {
      key,
      value: (row ? (row.value as boolean | number | string) : def.default) as
        boolean | number | string,
      type: def.type,
      default: def.default,
      description: def.description,
      updatedAt: row ? row.updatedAt.toISOString() : null,
      updatedBy: row ? row.updatedBy : null,
    };
  });
}

export interface FlagDto {
  key: string;
  enabled: boolean;
  rolloutPercent: number;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

const FLAG_KEY_RE = /^[a-z0-9][a-z0-9._-]{1,98}[a-z0-9]$/;

export function validateFlagKey(key: string): void {
  if (!FLAG_KEY_RE.test(key)) {
    throw Object.assign(
      new Error('Flag key must be 3-100 chars: lowercase letters, digits, dot, dash, underscore.'),
      { statusCode: 400 },
    );
  }
}

export async function listFlags(db: Db = prisma): Promise<FlagDto[]> {
  const rows = await db.featureFlag.findMany({ orderBy: { key: 'asc' } });
  return rows.map((r) => ({
    key: r.key,
    enabled: r.enabled,
    rolloutPercent: r.rolloutPercent,
    description: r.description,
    updatedAt: r.updatedAt.toISOString(),
    updatedBy: r.updatedBy,
  }));
}
