// Phase 4 — per-route rate-limit config for the general API surface.
// Auth endpoints keep their stricter dedicated limits from Phase 3.

import type { Config } from '../config.js';

export function apiRateLimit(config: Config): { max: number; timeWindow: number } {
  return { max: config.rateLimits.api, timeWindow: config.rateLimits.windowMs };
}
