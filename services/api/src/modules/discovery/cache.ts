// Phase 26 — recommendation result caching.
//
// Rules:
// - Cache keys are user-scoped: (userId, policyVersion, constraintHash).
//   Personalized results are NEVER shared across users.
// - Only deterministic (non-AI-query) recommendation responses are cached.
//   Natural-language queries go through the AI/fallback path every time
//   (they are rate-limited instead).
// - TTL is short; the cache is best-effort and in-memory (single-instance
//   scope, same as other Phase 18/25 in-memory controls).
// - Cached entries store the final response DTO only — no private
//   behavioral features, no raw signals.
//
// Staleness note: the cache is NOT invalidated when a user's signals
// change (new likes, follows, plays). A cached response may therefore be
// up to TTL old relative to the latest taste signals. This is accepted:
// recommendations are advisory, never authoritative, and callers can pass
// refresh=true to bypass the cache. The TTL default (5 minutes) bounds the
// staleness window.

import { createHash } from 'node:crypto';
import type { DiscoveryConstraints, RecommendationResponse } from './types.js';

export interface CacheEntry {
  response: RecommendationResponse;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

/** Deterministic hash of the constraint set for cache-key purposes. */
export function hashConstraints(c: DiscoveryConstraints): string {
  const canonical = JSON.stringify({
    genreIds: [...c.genreIds].sort(),
    moods: [...c.moods].sort(),
    energy: c.energy,
    tempoBpm: c.tempoBpm,
    era: c.era,
    artistIds: [...c.artistIds].sort(),
    emergingOnly: c.emergingOnly,
    limit: c.limit,
    exploration: c.exploration,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export class DiscoveryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private key(userId: string, policyVersion: string, constraintHash: string): string {
    // User-scoped key: personalized data cannot leak across users.
    return `${userId}:${policyVersion}:${constraintHash}`;
  }

  get(
    userId: string,
    policyVersion: string,
    constraintHash: string,
  ): RecommendationResponse | null {
    const entry = this.entries.get(this.key(userId, policyVersion, constraintHash));
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(this.key(userId, policyVersion, constraintHash));
      return null;
    }
    return entry.response;
  }

  set(
    userId: string,
    policyVersion: string,
    constraintHash: string,
    response: RecommendationResponse,
  ): void {
    if (this.entries.size >= MAX_ENTRIES) {
      // Evict the oldest entry (Map preserves insertion order).
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(this.key(userId, policyVersion, constraintHash), {
      response,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** For tests: current entry count. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
