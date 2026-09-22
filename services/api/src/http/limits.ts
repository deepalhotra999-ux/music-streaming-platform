// Phase 4 — per-route rate-limit config for the general API surface.
// Auth endpoints keep their stricter dedicated limits from Phase 3.

import type { Config } from '../config.js';

export function apiRateLimit(config: Config): { max: number; timeWindow: number } {
  return { max: config.rateLimits.api, timeWindow: config.rateLimits.windowMs };
}

/** Generous bucket for HLS delivery: a player legitimately fetches a manifest
 *  plus one request per segment, so this must not be as tight as the API bucket. */
export function streamingRateLimit(config: Config): { max: number; timeWindow: number } {
  return { max: config.rateLimits.streaming, timeWindow: config.rateLimits.windowMs };
}

/** Phase 25 — tight bucket for download authorization issuance: each call
 *  mints a delivery grant, so bulk farming must be expensive. Segment
 *  fetching itself uses the generous streaming bucket. */
export function offlineAuthorizeRateLimit(config: Config): { max: number; timeWindow: number } {
  return { max: config.rateLimits.offlineAuthorize, timeWindow: config.rateLimits.windowMs };
}
