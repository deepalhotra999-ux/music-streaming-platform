// Phase 26 — discovery API types.
//
// Mirrors the backend discovery DTOs (services/api/src/modules/discovery).
// Responses carry safe display metadata + truthful reasons + policy info.
// Internal ranking weights and private behavioral features never reach the
// client.

/** Why a track was recommended; derived from real signals, never invented. */
export type ReasonKind =
  | 'because_you_listen'
  | 'followed_artist'
  | 'liked_tracks'
  | 'similar_genre'
  | 'new_from_followed'
  | 'emerging_artist'
  | 'popular'
  | 'exploration';

/** Track DTO inside discovery responses (nested artist/album). */
export interface DiscoveryTrack {
  id: string;
  title: string;
  durationMs: number;
  artist: { id: string; name: string };
  album: { id: string; title: string } | null;
}

/** One recommendation: a real catalog track plus its truthful reason. */
export interface RecommendationItem {
  track: DiscoveryTrack;
  reason: string;
  reasonKind: ReasonKind;
}

/** Policy/version metadata attached to every discovery response. */
export interface PolicyInfo {
  policyVersion: string;
  /**
   * False for cold-start users: the response is NOT personalized and the
   * UI must say so honestly instead of faking personalization.
   */
  personalized: boolean;
  /**
   * Which AI layer interpreted the query: 'none' for the deterministic
   * path, 'deterministic-fallback' when AI output was invalid/unavailable.
   */
  aiProvider: string;
}

export interface RecommendationsResponse {
  requestId: string;
  policy: PolicyInfo;
  items: RecommendationItem[];
  candidateCount: number;
  generatedAt: string;
}

export interface EmergingArtist {
  artistId: string;
  artistName: string;
  recentStreams: number;
}

export interface EmergingArtistsResponse {
  artists: EmergingArtist[];
}

/** Structured constraints the AI layer (or deterministic parser) produced. */
export interface DiscoveryConstraints {
  genreIds: string[];
  artistIds: string[];
  moods: string[];
  energy: number | null;
  emergingOnly: boolean;
  limit: number;
  exploration: number;
}

export interface PlaylistCriteriaResponse {
  requestId: string;
  criteria: DiscoveryConstraints;
  items: RecommendationItem[];
  aiProvider: string;
}

/** Section headers for grouping recommendations by reason kind. */
export const REASON_SECTION_TITLES: Record<ReasonKind, string> = {
  because_you_listen: 'Because you listen',
  followed_artist: 'From artists you follow',
  liked_tracks: 'Based on your likes',
  similar_genre: 'More of what you like',
  new_from_followed: 'New from artists you follow',
  emerging_artist: 'Emerging artists',
  popular: 'Popular right now',
  exploration: 'Worth exploring',
};

/**
 * The feed heading. Cold-start users (personalized === false) get an
 * honest non-personalized heading — never "For you".
 */
export function feedHeading(personalized: boolean): string {
  return personalized ? 'For you' : 'Popular right now';
}

/**
 * Reason kinds that are genuinely personalized. When policy.personalized
 * is false the backend only emits non-personalized kinds, but the client
 * double-checks so cold-start UI can never show a fake "for you" reason.
 */
export const PERSONALIZED_REASON_KINDS: ReadonlySet<ReasonKind> = new Set([
  'because_you_listen',
  'followed_artist',
  'liked_tracks',
  'similar_genre',
  'new_from_followed',
]);
