// Phase 26 — versioned recommendation policies.
//
// A policy is a plain, serializable configuration object. Ranking reads only
// the policy: no hidden weights, no black-box score. A recommendation request
// with the same input snapshot and policy version produces deterministic
// ordering. Policy versions are never mutated in place; changes create a new
// version so ranking behavior can be identified and compared.

import type { DiscoveryConstraints } from './types.js';

export interface RankingWeights {
  /** Affinity to the user's top artists. */
  artistAffinity: number;
  /** Affinity to the user's top genres. */
  genreAffinity: number;
  /** Recency of the candidate's release / catalog freshness. */
  recency: number;
  /** Raw popularity (playCount), log-scaled. */
  popularity: number;
  /** Alignment with explicit discovery constraints (genres/artists). */
  constraintMatch: number;
  /** Bonus for candidates from emerging artists. */
  emergingBoost: number;
  /** Penalty for tracks the user already heard a lot. */
  repetitionPenalty: number;
}

export interface DiversityConfig {
  /** Max tracks from one artist in a single response. */
  maxPerArtist: number;
  /** Max tracks sharing one genre in a single response. */
  maxPerGenre: number;
  /** Fraction of slots reserved for exploration (0..1). */
  explorationFraction: number;
}

export interface EmergingArtistPolicy {
  /** Artist must have been created within this many days. */
  maxAgeDays: number;
  /** Stream growth window in days for the growth check. */
  growthWindowDays: number;
  /** Minimum growth ratio (recent/previous) to qualify. */
  minGrowthRatio: number;
  /** Eligible-stream volume range for "emerging" (inclusive). */
  minStreams: number;
  maxStreams: number;
  /** Max total historical streams to still count as limited exposure. */
  maxHistoricalStreams: number;
}

export interface RecommendationPolicy {
  version: string;
  weights: RankingWeights;
  diversity: DiversityConfig;
  emerging: EmergingArtistPolicy;
  /** Max candidates any single generator may contribute. */
  maxCandidatesPerGenerator: number;
  /** Hard cap on the candidate pool before ranking. */
  maxCandidatePool: number;
  /** Default result limit when the caller does not specify one. */
  defaultLimit: number;
  /** Absolute max result limit. */
  maxLimit: number;
  /** Cold-start: how many popular tracks to blend in. */
  coldStartPopularCount: number;
}

export const POLICY_V1: RecommendationPolicy = {
  version: 'v1',
  weights: {
    artistAffinity: 3.0,
    genreAffinity: 2.0,
    recency: 1.0,
    popularity: 1.0,
    constraintMatch: 4.0,
    emergingBoost: 1.5,
    repetitionPenalty: 2.5,
  },
  diversity: {
    maxPerArtist: 2,
    maxPerGenre: 5,
    explorationFraction: 0.25,
  },
  emerging: {
    maxAgeDays: 365,
    growthWindowDays: 28,
    minGrowthRatio: 1.5,
    minStreams: 10,
    maxStreams: 10000,
    maxHistoricalStreams: 50000,
  },
  maxCandidatesPerGenerator: 60,
  maxCandidatePool: 400,
  defaultLimit: 20,
  maxLimit: 50,
  coldStartPopularCount: 10,
};

/** Registry of known policy versions. Unknown versions are rejected. */
const POLICIES: Record<string, RecommendationPolicy> = {
  v1: POLICY_V1,
};

export const CURRENT_POLICY_VERSION = 'v1';

export function getPolicy(version: string): RecommendationPolicy {
  const policy = POLICIES[version];
  if (!policy) {
    throw new Error(`Unknown recommendation policy version: ${version}`);
  }
  return policy;
}

/** Clamp caller-supplied constraints to policy bounds. */
export function clampConstraints(
  constraints: DiscoveryConstraints,
  policy: RecommendationPolicy,
): DiscoveryConstraints {
  return {
    ...constraints,
    limit: Math.min(Math.max(1, constraints.limit), policy.maxLimit),
    exploration: Math.min(Math.max(0, constraints.exploration), 1),
    energy: constraints.energy === null ? null : Math.min(Math.max(0, constraints.energy), 1),
  };
}
