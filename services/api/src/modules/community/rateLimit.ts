// Phase 29 — per-user rate limiting for community write endpoints.
//
// The platform's @fastify/rate-limit buckets are IP-keyed. Community writes
// additionally need per-account buckets keyed by the AUTHENTICATED server
// identity (req.authUser.id) so a malicious client cannot dodge limits by
// rotating IPs, and so one abusive account behind shared NAT cannot burn
// the budget of everyone on that IP.
//
// In-memory sliding windows: same single-instance limitation as the Phase 3
// IP buckets and the Phase 28 in-process room hub. Multi-instance deploys
// need a shared store (documented in docs/ARTIST-FAN-COMMUNITY.md).

import { tooManyRequests } from '../../http/errors.js';

interface Window {
  timestamps: number[];
}

const windows = new Map<string, Window>();

/** Test seam: clears all buckets. */
export function resetCommunityRateLimits(): void {
  windows.clear();
}

function prune(window: Window, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  while (window.timestamps.length > 0 && window.timestamps[0]! <= cutoff) {
    window.timestamps.shift();
  }
}

/**
 * Consumes one token from the caller's bucket for `action`. Throws a 429
 * HttpProblem when the bucket is exhausted. `userId` must come from the
 * authenticated request — never from client input.
 */
export function checkUserRateLimit(
  userId: string,
  action: string,
  max: number,
  windowMs: number,
): void {
  const now = Date.now();
  const key = `${action}:${userId}`;
  let window = windows.get(key);
  if (!window) {
    window = { timestamps: [] };
    windows.set(key, window);
  }
  prune(window, now, windowMs);
  if (window.timestamps.length >= max) {
    throw tooManyRequests(`Rate limit exceeded for ${action}. Try again shortly.`);
  }
  window.timestamps.push(now);
}
