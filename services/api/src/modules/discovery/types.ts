// Phase 26 — AI Music Discovery & Recommendation Engine. Shared domain types.
//
// Architecture separation:
//   signals.ts    -> user signal extraction (first-party behavioral data)
//   candidates.ts -> candidate generation from real catalog entities
//   emerging.ts   -> emerging-artist discovery policy
//   ranking.ts    -> deterministic, versioned, testable ranking
//   ai.ts         -> provider-neutral AI interpretation (NL -> constraints)
//   sanitize.ts   -> untrusted-data handling, AI output schema validation
//   authz.ts      -> final catalog/availability/entitlement filtering
//   service.ts    -> orchestration: signals -> candidates -> rank -> filter
//
// Invariants enforced across the module:
// - Every recommended entity is a real catalog row resolved by stable ID.
// - Titles/names are never used as entity identity.
// - AI output is a structured constraint set, never authoritative music objects.
// - Recommendation ranking never mutates royalties, history, or subscriptions.

/** Stable catalog entity identity. Titles/names are display-only. */
export interface EntityRef {
  kind: 'track' | 'artist' | 'album' | 'genre' | 'playlist';
  id: string;
}

/** Strength of a behavioral signal. */
export type SignalStrength = 'strong' | 'weak';

/** One extracted user signal: what we observed, how strongly it counts. */
export interface UserSignal {
  kind:
    | 'completed_play'
    | 'partial_play'
    | 'like'
    | 'follow'
    | 'playlist_add'
    | 'genre_interaction'
    | 'artist_interaction';
  strength: SignalStrength;
  trackId?: string;
  artistId?: string;
  genreId?: string;
  /** Recency weight multiplier in (0, 1]. */
  recency: number;
  observedAt: Date;
}

/** Aggregated per-user taste profile used by candidate generation. */
export interface SignalProfile {
  userId: string;
  /** True when the user has too little history to personalize. */
  isColdStart: boolean;
  topArtistIds: string[];
  topGenreIds: string[];
  likedTrackIds: string[];
  likedArtistIds: string[];
  followedArtistIds: string[];
  recentTrackIds: string[];
  /** Track IDs the user has already heard a lot; deprioritize repetition. */
  overexposedTrackIds: string[];
}

/**
 * Structured intermediate representation produced by the AI layer (or the
 * deterministic NL parser). This is what the deterministic pipeline consumes.
 * The AI must never return music objects directly.
 */
export interface DiscoveryConstraints {
  /** Genre IDs resolved against the real genre catalog (stable IDs). */
  genreIds: string[];
  /** Free-text mood descriptors; used only as soft ranking hints. */
  moods: string[];
  /** Desired energy in [0, 1], or null when unspecified. */
  energy: number | null;
  /** Tempo hint; the catalog has no tempo column, so this stays a hint. */
  tempoBpm: number | null;
  /** Era hint as free text (e.g. "90s"); soft hint only. */
  era: string | null;
  /** Artist IDs referenced by name resolution; stable IDs only. */
  artistIds: string[];
  /** Whether to restrict to emerging artists. */
  emergingOnly: boolean;
  /** Number of results requested (clamped server-side). */
  limit: number;
  /** Exploration appetite in [0, 1]; higher = more novelty. */
  exploration: number;
}

/** A candidate track before ranking. */
export interface Candidate {
  trackId: string;
  /** Which generator produced it (used for reasons and telemetry). */
  source:
    | 'recently_played_related'
    | 'liked_artist'
    | 'followed_artist'
    | 'genre_affinity'
    | 'popular'
    | 'new_release'
    | 'emerging'
    | 'similar_artist';
  /** Anchor entity the candidate relates to (stable ID), for reasons. */
  anchorId: string | null;
  anchorKind: 'artist' | 'genre' | 'track' | null;
}

/** Candidate with a deterministic score and its contributing factors. */
export interface ScoredCandidate extends Candidate {
  score: number;
  /** Factor name -> contribution; testable, no black box. */
  factors: Record<string, number>;
}

/** One finalized recommendation item. */
export interface RecommendationItem {
  track: {
    id: string;
    title: string;
    durationMs: number;
    artist: { id: string; name: string };
    album: { id: string; title: string } | null;
  };
  /** Truthful reason derived from actual signals, never fabricated. */
  reason: string;
  reasonKind:
    | 'because_you_listen'
    | 'followed_artist'
    | 'liked_tracks'
    | 'similar_genre'
    | 'new_from_followed'
    | 'emerging_artist'
    | 'popular'
    | 'exploration';
}

/** Policy/version metadata attached to every response (safe to expose). */
export interface PolicyInfo {
  policyVersion: string;
  personalized: boolean;
  aiProvider: string;
}

/** Full recommendation response. */
export interface RecommendationResponse {
  requestId: string;
  policy: PolicyInfo;
  items: RecommendationItem[];
  /** Total candidates considered before filtering (telemetry-safe). */
  candidateCount: number;
  generatedAt: string;
}
