// Phase 26 — deterministic ranking.
//
// Scores are a weighted sum of named factors; every contribution is recorded
// on the ScoredCandidate so tests can assert exactly why an item ranked
// where it did. No hidden weights, no black box.
//
// Determinism: for a fixed candidate snapshot + policy version + constraints,
// ordering is fully deterministic. Ties break by trackId (lexicographic),
// never by insertion order or randomness.
//
// Diversity is applied as a post-sort pass: at most maxPerArtist tracks per
// artist and maxPerGenre per genre survive, and a configurable exploration
// fraction of slots is reserved for exploration sources (emerging,
// new_release, popular-when-cold-start) so the response is never just the
// user's most-played artist on repeat.

import type { PrismaClient } from '@prisma/client';
import type { Candidate, DiscoveryConstraints, ScoredCandidate, SignalProfile } from './types.js';
import type { RecommendationPolicy } from './policies.js';

type Db = PrismaClient;

interface TrackFeatures {
  id: string;
  artistId: string;
  genreIds: string[];
  playCount: bigint;
  createdAt: Date;
}

const EXPLORATION_SOURCES: Candidate['source'][] = ['emerging', 'new_release', 'popular'];

/** Load the features ranking needs for a candidate set (one batched query). */
export async function loadFeatures(
  db: Db,
  trackIds: string[],
): Promise<Map<string, TrackFeatures>> {
  const rows = await db.track.findMany({
    where: { id: { in: trackIds } },
    select: {
      id: true,
      artistId: true,
      playCount: true,
      createdAt: true,
      genres: { select: { genreId: true } },
    },
  });
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        artistId: r.artistId,
        genreIds: r.genres.map((g) => g.genreId),
        playCount: r.playCount,
        createdAt: r.createdAt,
      },
    ]),
  );
}

function logScaledPlayCount(playCount: bigint): number {
  return Math.log10(Number(playCount) + 1);
}

function recencyScore(createdAt: Date, now: Date): number {
  const days = Math.max(0, (now.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
  // 1.0 for brand-new, decaying to ~0 at 2 years.
  return Math.max(0, 1 - days / 730);
}

/**
 * Score every candidate deterministically. Pure function of
 * (candidate, features, profile, constraints, policy, now).
 */
export function scoreCandidates(
  candidates: Candidate[],
  features: Map<string, TrackFeatures>,
  profile: SignalProfile,
  constraints: DiscoveryConstraints,
  policy: RecommendationPolicy,
  emergingArtistIds: Set<string>,
  now: Date = new Date(),
): ScoredCandidate[] {
  const w = policy.weights;
  const topArtistRank = new Map(profile.topArtistIds.map((id, i) => [id, i]));
  const topGenreRank = new Map(profile.topGenreIds.map((id, i) => [id, i]));
  const constraintGenres = new Set(constraints.genreIds);
  const constraintArtists = new Set(constraints.artistIds);
  const overexposed = new Set(profile.overexposedTrackIds);
  const recent = new Set(profile.recentTrackIds);

  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    const f = features.get(c.trackId);
    if (!f) continue;
    const factors: Record<string, number> = {};

    // Artist affinity: stronger for higher-ranked top artists.
    const artistRank = topArtistRank.get(f.artistId);
    factors.artistAffinity =
      artistRank === undefined
        ? 0
        : w.artistAffinity * (1 - artistRank / profile.topArtistIds.length);

    // Genre affinity: best matching top genre.
    let genreAffinity = 0;
    for (const gid of f.genreIds) {
      const rank = topGenreRank.get(gid);
      if (rank !== undefined) {
        genreAffinity = Math.max(
          genreAffinity,
          w.genreAffinity * (1 - rank / profile.topGenreIds.length),
        );
      }
    }
    factors.genreAffinity = genreAffinity;

    factors.recency = w.recency * recencyScore(f.createdAt, now);
    factors.popularity = w.popularity * logScaledPlayCount(f.playCount);

    // Explicit constraint match (from NL discovery or caller filters).
    let constraintMatch = 0;
    if (constraintArtists.has(f.artistId)) constraintMatch += w.constraintMatch;
    if (f.genreIds.some((g) => constraintGenres.has(g))) {
      constraintMatch += w.constraintMatch * 0.5;
    }
    factors.constraintMatch = constraintMatch;

    factors.emergingBoost = emergingArtistIds.has(f.artistId) ? w.emergingBoost : 0;

    // Penalties: overexposed tracks and tracks heard very recently.
    factors.repetitionPenalty =
      (overexposed.has(c.trackId) ? w.repetitionPenalty : 0) +
      (recent.has(c.trackId) ? w.repetitionPenalty * 0.5 : 0);

    const score = Object.values(factors).reduce((a, b) => a + b, 0);
    scored.push({ ...c, score, factors });
  }

  // Deterministic order: score desc, then trackId asc.
  scored.sort((a, b) => b.score - a.score || (a.trackId < b.trackId ? -1 : 1));
  return scored;
}

/**
 * Apply diversity constraints and the exploration reservation.
 * Returns the final ordered list, capped at `limit`.
 */
export function applyDiversity(
  scored: ScoredCandidate[],
  features: Map<string, TrackFeatures>,
  policy: RecommendationPolicy,
  constraints: DiscoveryConstraints,
  limit: number,
): ScoredCandidate[] {
  const d = policy.diversity;
  const explorationSlots = Math.max(
    1,
    Math.round(limit * Math.max(d.explorationFraction, constraints.exploration * 0.5)),
  );

  const perArtist = new Map<string, number>();
  const perGenre = new Map<string, number>();
  const picked: ScoredCandidate[] = [];
  const deferred: ScoredCandidate[] = [];

  for (const c of scored) {
    const f = features.get(c.trackId);
    if (!f) continue;
    const artistCount = perArtist.get(f.artistId) ?? 0;
    if (artistCount >= d.maxPerArtist) {
      deferred.push(c);
      continue;
    }
    let genreBlocked = false;
    for (const gid of f.genreIds) {
      if ((perGenre.get(gid) ?? 0) >= d.maxPerGenre) {
        genreBlocked = true;
        break;
      }
    }
    if (genreBlocked) {
      deferred.push(c);
      continue;
    }
    perArtist.set(f.artistId, artistCount + 1);
    for (const gid of f.genreIds) {
      perGenre.set(gid, (perGenre.get(gid) ?? 0) + 1);
    }
    picked.push(c);
    if (picked.length >= limit) break;
  }

  // Exploration reservation: ensure at least `explorationSlots` picks come
  // from exploration sources when the pool allows it. Replacements respect
  // the same per-artist / per-genre caps as the initial pass: an explorer
  // that would push an artist or genre over its cap is skipped.
  const explorationPicked = picked.filter((c) => EXPLORATION_SOURCES.includes(c.source)).length;
  if (explorationPicked < explorationSlots) {
    const need = explorationSlots - explorationPicked;
    const pickedSet = new Set<ScoredCandidate>(picked);
    const explorers = scored.filter(
      (c) => EXPLORATION_SOURCES.includes(c.source) && !pickedSet.has(c),
    );
    // Replace the lowest-scoring non-exploration picks.
    let replaced = 0;
    for (let i = picked.length - 1; i >= 0 && replaced < need; i--) {
      const victim = picked[i];
      if (EXPLORATION_SOURCES.includes(victim.source)) continue;
      const candidate = explorers[replaced];
      if (!candidate) break;
      const vf = features.get(victim.trackId);
      const cf = features.get(candidate.trackId);
      if (!vf || !cf) continue;
      // Simulate the swap: victim counts removed, candidate counts added.
      const victimGenres = new Set(vf.genreIds);
      const artistCount = (perArtist.get(cf.artistId) ?? 0) - (vf.artistId === cf.artistId ? 1 : 0);
      if (artistCount >= d.maxPerArtist) continue;
      let genreBlocked = false;
      for (const gid of cf.genreIds) {
        const g = (perGenre.get(gid) ?? 0) - (victimGenres.has(gid) ? 1 : 0);
        if (g >= d.maxPerGenre) {
          genreBlocked = true;
          break;
        }
      }
      if (genreBlocked) continue;
      // Apply the swap and keep the counters exact.
      perArtist.set(vf.artistId, (perArtist.get(vf.artistId) ?? 1) - 1);
      for (const gid of vf.genreIds) {
        perGenre.set(gid, (perGenre.get(gid) ?? 1) - 1);
      }
      perArtist.set(cf.artistId, (perArtist.get(cf.artistId) ?? 0) + 1);
      for (const gid of cf.genreIds) {
        perGenre.set(gid, (perGenre.get(gid) ?? 0) + 1);
      }
      picked[i] = candidate;
      replaced++;
    }
  }

  return picked.slice(0, limit);
}
