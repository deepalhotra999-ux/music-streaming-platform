// Phase 26 — typed wrappers for the discovery API.
//
// All four endpoints are authenticated; the shared ApiClient injects the
// Bearer token and surfaces RFC 7807 errors (including 429 rate limits)
// as ApiError. No backend changes — these are thin typed calls.

import type { ApiClient } from '../api';
import type {
  EmergingArtistsResponse,
  PlaylistCriteriaResponse,
  RecommendationsResponse,
} from './types';

export interface RecommendationsQuery {
  limit?: number;
  genreId?: string;
  artistId?: string;
  emergingOnly?: boolean;
  /** Bypass the server-side recommendation cache. */
  refresh?: boolean;
}

function toQueryString(params: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** Deterministic recommendations (personalized, or honest cold-start). */
export function getRecommendations(
  client: ApiClient,
  query: RecommendationsQuery = {},
): Promise<RecommendationsResponse> {
  const params: Record<string, string | number | boolean | undefined> = {
    limit: query.limit,
    genreId: query.genreId,
    artistId: query.artistId,
    emergingOnly: query.emergingOnly,
    refresh: query.refresh,
  };
  return client.get<RecommendationsResponse>(
    `/v1/discovery/recommendations${toQueryString(params)}`,
  );
}

/** Natural-language discovery: AI interprets the query into constraints. */
export function queryDiscovery(
  client: ApiClient,
  query: string,
  limit?: number,
): Promise<RecommendationsResponse> {
  return client.post<RecommendationsResponse>('/v1/discovery/query', { query, limit });
}

/** Emerging-artist spotlight by measurable growth criteria. */
export function getEmergingArtists(client: ApiClient): Promise<EmergingArtistsResponse> {
  return client.get<EmergingArtistsResponse>('/v1/discovery/emerging');
}

export interface PlaylistCriteriaInput {
  query: string;
  limit?: number;
  name?: string;
}

/**
 * AI-assisted playlist criteria + candidate tracks. Creates nothing —
 * the caller builds the playlist itself through the library API after
 * the user confirms.
 */
export function getPlaylistCriteria(
  client: ApiClient,
  input: PlaylistCriteriaInput,
): Promise<PlaylistCriteriaResponse> {
  return client.post<PlaylistCriteriaResponse>('/v1/discovery/playlist-criteria', input);
}
