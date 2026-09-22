// Phase 26 — discovery service orchestration.
//
// Pipeline: signals -> candidates -> ranking -> authorization filtering ->
// response. Each stage is independently testable; this module wires them.
//
// Guarantees:
// - Output entities are real catalog rows (stable IDs), verified in authz.
// - AI output is validated + re-resolved; invalid AI output falls back to
//   deterministic discovery without failing the request.
// - Recommendation ranking never touches royalties, history, or
//   subscriptions (read-only over play_events/listening_history).
// - Reasons are derived from actual signals, never fabricated.

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type {
  DiscoveryConstraints,
  RecommendationItem,
  RecommendationResponse,
  SignalProfile,
} from './types.js';
import { CURRENT_POLICY_VERSION, clampConstraints, getPolicy } from './policies.js';
import { extractSignals } from './signals.js';
import { generateCandidates } from './candidates.js';
import { emergingTrackIds, findEmergingArtists } from './emerging.js';
import { applyDiversity, loadFeatures, scoreCandidates } from './ranking.js';
import { authorizeTracks, resolveArtistIds, resolveGenreIds } from './authz.js';
import { createAIProvider, type RecommendationAIProvider } from './ai.js';
import { sanitizeDisplayText, validateAIConstraints } from './sanitize.js';
import { DiscoveryCache, hashConstraints } from './cache.js';
import { emitTelemetry, queryLengthBucket } from './telemetry.js';

type Db = PrismaClient;

export interface DiscoveryDeps {
  db: Db;
  cache?: DiscoveryCache;
  aiProvider?: RecommendationAIProvider;
  now?: () => Date;
}

export interface RecommendOptions {
  /** Structured constraints (deterministic path). */
  constraints?: Partial<DiscoveryConstraints>;
  /** Natural-language query (AI path). */
  query?: string;
  /** Skip the cache (e.g. explicit refresh). */
  noCache?: boolean;
  /**
   * Called once with the final validated + catalog-resolved constraints.
   * Lets callers (e.g. playlist-criteria) report exactly what the AI
   * understood without re-running interpretation.
   */
  onConstraints?: (constraints: DiscoveryConstraints) => void;
}

function defaultConstraints(limit: number): DiscoveryConstraints {
  return {
    genreIds: [],
    moods: [],
    energy: null,
    tempoBpm: null,
    era: null,
    artistIds: [],
    emergingOnly: false,
    limit,
    exploration: 0.5,
  };
}

/** Exported for tests: reason derivation must stay truthful. */
export function reasonFor(
  source: string,
  profile: SignalProfile,
  anchorName: string | null,
  artistId: string | null,
): { reason: string; reasonKind: RecommendationItem['reasonKind'] } {
  const followedArtistIds = new Set(profile.followedArtistIds);
  switch (source) {
    case 'recently_played_related':
      return {
        reason: anchorName
          ? `Because you listen to ${anchorName}`
          : 'Based on your recent listening',
        reasonKind: 'because_you_listen',
      };
    case 'followed_artist':
      return {
        reason: anchorName
          ? `New from ${anchorName}, an artist you follow`
          : 'From an artist you follow',
        reasonKind: 'followed_artist',
      };
    case 'liked_artist':
      return {
        reason: 'Based on tracks you liked',
        reasonKind: 'liked_tracks',
      };
    case 'genre_affinity':
      return { reason: 'Similar genre to your taste', reasonKind: 'similar_genre' };
    case 'emerging':
      return { reason: 'Emerging artist worth a listen', reasonKind: 'emerging_artist' };
    case 'new_release': {
      // 'new_from_followed' is only truthful when the user actually follows
      // this artist; otherwise it is just a new release.
      const isFollowed = artistId !== null && followedArtistIds.has(artistId);
      return isFollowed
        ? {
            reason: anchorName
              ? `New from ${anchorName}, an artist you follow`
              : 'New release from an artist you follow',
            reasonKind: 'new_from_followed',
          }
        : { reason: 'New release', reasonKind: 'popular' };
    }
    case 'similar_artist':
      return {
        reason: anchorName ? `Similar to ${anchorName}` : 'Similar artist',
        reasonKind: 'because_you_listen',
      };
    case 'popular':
    default:
      return { reason: 'Popular right now', reasonKind: 'popular' };
  }
}

export async function recommend(
  deps: DiscoveryDeps,
  userId: string,
  options: RecommendOptions = {},
): Promise<RecommendationResponse> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const now = deps.now?.() ?? new Date();
  const policy = getPolicy(CURRENT_POLICY_VERSION);
  const cache = deps.cache ?? new DiscoveryCache();
  const aiProvider = deps.aiProvider ?? createAIProvider(deps.db);

  let failureCategory: string | null = null;
  let aiProviderName = 'none';
  let candidateCount = 0;
  let droppedCount = 0;
  let personalized = true;

  try {
    // 1. Constraints: NL query via AI (+ validated), or deterministic.
    let constraints: DiscoveryConstraints;
    if (options.query && options.query.trim().length > 0) {
      const genreNames = (await deps.db.genre.findMany({ select: { name: true }, take: 200 })).map(
        (g) => g.name,
      );
      try {
        const result = await aiProvider.interpret({
          query: options.query.slice(0, 500),
          genreNames,
          limit: policy.defaultLimit,
        });
        const validated = validateAIConstraints(result.constraints, policy.defaultLimit);
        if (validated) {
          constraints = clampConstraints(validated, policy);
          aiProviderName = result.providerName;
        } else {
          // Invalid AI output fails safely to deterministic discovery.
          failureCategory = 'invalid_ai_output';
          constraints = defaultConstraints(policy.defaultLimit);
          aiProviderName = 'deterministic-fallback';
        }
      } catch {
        // AI unavailable: graceful deterministic fallback.
        failureCategory = 'ai_unavailable';
        constraints = defaultConstraints(policy.defaultLimit);
        aiProviderName = 'deterministic-fallback';
      }
      if (options.constraints?.limit) {
        constraints.limit = Math.min(options.constraints.limit, policy.maxLimit);
      }
    } else {
      constraints = clampConstraints(
        { ...defaultConstraints(policy.defaultLimit), ...options.constraints },
        policy,
      );
      aiProviderName = 'deterministic';
    }

    // Re-resolve IDs against the real catalog (AI can never invent entities).
    constraints.genreIds = await resolveGenreIds(deps.db, constraints.genreIds);
    constraints.artistIds = await resolveArtistIds(deps.db, constraints.artistIds);
    options.onConstraints?.({ ...constraints });

    // 2. Cache lookup (deterministic path only; NL queries are not cached
    //    because their constraint derivation is the expensive part and is
    //    rate-limited separately).
    const cacheable = !options.query && !options.noCache;
    const constraintHash = hashConstraints(constraints);
    if (cacheable) {
      const hit = cache.get(userId, policy.version, constraintHash);
      if (hit) {
        emitTelemetry({
          requestId,
          policyVersion: policy.version,
          candidateCount: hit.candidateCount,
          finalCount: hit.items.length,
          droppedCount: 0,
          aiProvider: 'cache',
          latencyMs: Date.now() - startedAt,
          failureCategory: null,
          personalized: hit.policy.personalized,
          queryLengthBucket: queryLengthBucket(options.query ?? null),
        });
        return hit;
      }
    }

    // 3. Signals (server-side only).
    const { profile } = await extractSignals(deps.db, userId, now);
    personalized = !profile.isColdStart;

    // 4. Emerging artists (policy-driven, measurable criteria).
    const emergingArtists = await findEmergingArtists(deps.db, policy.emerging, now);
    const emergingIds = new Set(emergingArtists.map((a) => a.artistId));
    let emergingTracks = await emergingTrackIds(deps.db, [...emergingIds], 3);
    if (constraints.emergingOnly) {
      // When the caller asked for emerging only, the candidate pool is
      // restricted to emerging-artist tracks.
      emergingTracks = await emergingTrackIds(deps.db, [...emergingIds], 10);
    }

    // 5. Candidates.
    const { candidates } = await generateCandidates(
      deps.db,
      profile,
      constraints,
      policy,
      emergingTracks,
    );
    const pool = constraints.emergingOnly
      ? candidates.filter((c) => c.source === 'emerging')
      : candidates;
    candidateCount = pool.length;

    // 6. Ranking (deterministic).
    const features = await loadFeatures(
      deps.db,
      pool.map((c) => c.trackId),
    );
    const scored = scoreCandidates(pool, features, profile, constraints, policy, emergingIds, now);
    const diverse = applyDiversity(scored, features, policy, constraints, constraints.limit);

    // 7. Authorization filtering (authoritative gate).
    const { authorized, dropped } = await authorizeTracks(
      deps.db,
      userId,
      diverse.map((c) => c.trackId),
    );
    droppedCount = dropped.length;
    const scoredById = new Map(diverse.map((c) => [c.trackId, c]));
    // Batch anchor artist-name lookup: one query, not one per candidate.
    const anchorArtistIds = [
      ...new Set(
        diverse
          .filter((c) => c.anchorId !== null && c.anchorKind === 'artist')
          .map((c) => c.anchorId as string),
      ),
    ];
    const anchorNames = new Map<string, string>();
    if (anchorArtistIds.length > 0) {
      const anchorArtists = await deps.db.artist.findMany({
        where: { id: { in: anchorArtistIds } },
        select: { id: true, name: true },
      });
      for (const a of anchorArtists) anchorNames.set(a.id, a.name);
    }

    // 8. Response with truthful reasons.
    const items: RecommendationItem[] = [];
    for (const track of authorized) {
      const sc = scoredById.get(track.id);
      const { reason, reasonKind } = reasonFor(
        sc?.source ?? 'popular',
        profile,
        sc?.anchorId ? (anchorNames.get(sc.anchorId) ?? null) : null,
        track.artistId,
      );
      items.push({
        track: {
          id: track.id,
          title: sanitizeDisplayText(track.title),
          durationMs: track.durationMs,
          artist: {
            id: track.artistId,
            name: sanitizeDisplayText(track.artistName),
          },
          album: track.albumId
            ? {
                id: track.albumId,
                title: sanitizeDisplayText(track.albumTitle ?? ''),
              }
            : null,
        },
        reason,
        reasonKind,
      });
    }

    const response: RecommendationResponse = {
      requestId,
      policy: {
        policyVersion: policy.version,
        personalized,
        aiProvider: aiProviderName,
      },
      items,
      candidateCount,
      generatedAt: now.toISOString(),
    };

    if (cacheable) {
      cache.set(userId, policy.version, constraintHash, response);
    }

    emitTelemetry({
      requestId,
      policyVersion: policy.version,
      candidateCount,
      finalCount: items.length,
      droppedCount,
      aiProvider: aiProviderName,
      latencyMs: Date.now() - startedAt,
      failureCategory,
      personalized,
      queryLengthBucket: queryLengthBucket(options.query ?? null),
    });

    return response;
  } catch (err) {
    emitTelemetry({
      requestId,
      policyVersion: CURRENT_POLICY_VERSION,
      candidateCount,
      finalCount: 0,
      droppedCount,
      aiProvider: aiProviderName,
      latencyMs: Date.now() - startedAt,
      failureCategory: 'internal_error',
      personalized,
      queryLengthBucket: queryLengthBucket(options.query ?? null),
    });
    throw err;
  }
}

/** Emerging-artist spotlight: policy-driven list, no personalization needed. */
export async function emergingSpotlight(
  deps: DiscoveryDeps,
  limit = 10,
): Promise<{ artistId: string; artistName: string; recentStreams: number }[]> {
  const policy = getPolicy(CURRENT_POLICY_VERSION);
  const now = deps.now?.() ?? new Date();
  const artists = await findEmergingArtists(deps.db, policy.emerging, now, limit);
  return artists.map((a) => ({
    artistId: a.artistId,
    artistName: sanitizeDisplayText(a.artistName),
    recentStreams: a.recentStreams,
  }));
}
