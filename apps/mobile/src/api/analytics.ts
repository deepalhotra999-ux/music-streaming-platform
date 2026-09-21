// Phase 15 — artist analytics & reporting API wrappers.
//
// Thin wrappers over the Phase 15 analytics endpoints. Every call requires
// an authenticated client; the backend enforces ARTIST/ADMIN roles plus
// artist ownership (canManageArtist) and computes all metrics server-side
// from the play_events stream — the client sends only the artist id, range,
// and optional track/album filters.

import type { ApiClient } from './client';
import type {
  AlbumAnalytics,
  AnalyticsOverview,
  AnalyticsRange,
  AnalyticsTrend,
  Page,
  RecentPlay,
  TrackAnalytics,
  TrendGranularity,
} from './types';

export interface AnalyticsQuery {
  range?: AnalyticsRange;
  trackId?: string;
  albumId?: string;
}

export interface AnalyticsPagedQuery extends AnalyticsQuery {
  page?: number;
  limit?: number;
}

export interface AnalyticsTrendQuery extends AnalyticsQuery {
  granularity?: TrendGranularity;
}

export interface AnalyticsRecentQuery extends AnalyticsQuery {
  limit?: number;
}

function toQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

const base = (artistId: string) => `/v1/artists/${artistId}/analytics`;

export function getArtistOverview(client: ApiClient, artistId: string, query: AnalyticsQuery = {}) {
  return client.get<AnalyticsOverview>(
    `${base(artistId)}/overview${toQueryString({
      range: query.range,
      trackId: query.trackId,
      albumId: query.albumId,
    })}`,
  );
}

export function getArtistTrackStats(
  client: ApiClient,
  artistId: string,
  query: AnalyticsPagedQuery = {},
) {
  return client.get<Page<TrackAnalytics>>(
    `${base(artistId)}/tracks${toQueryString({
      range: query.range,
      trackId: query.trackId,
      albumId: query.albumId,
      page: query.page,
      limit: query.limit,
    })}`,
  );
}

export function getArtistAlbumStats(
  client: ApiClient,
  artistId: string,
  query: AnalyticsPagedQuery = {},
) {
  return client.get<Page<AlbumAnalytics>>(
    `${base(artistId)}/albums${toQueryString({
      range: query.range,
      trackId: query.trackId,
      albumId: query.albumId,
      page: query.page,
      limit: query.limit,
    })}`,
  );
}

export function getArtistTrend(
  client: ApiClient,
  artistId: string,
  query: AnalyticsTrendQuery = {},
) {
  return client.get<AnalyticsTrend>(
    `${base(artistId)}/trend${toQueryString({
      range: query.range,
      trackId: query.trackId,
      albumId: query.albumId,
      granularity: query.granularity,
    })}`,
  );
}

export function getArtistRecentActivity(
  client: ApiClient,
  artistId: string,
  query: AnalyticsRecentQuery = {},
) {
  return client.get<{ data: RecentPlay[] }>(
    `${base(artistId)}/recent${toQueryString({
      range: query.range,
      trackId: query.trackId,
      albumId: query.albumId,
      limit: query.limit,
    })}`,
  );
}

/** Platform-wide overview. ADMIN only — the backend rejects other roles. */
export function getPlatformOverview(client: ApiClient, query: { range?: AnalyticsRange } = {}) {
  return client.get<AnalyticsOverview>(
    `/v1/analytics/platform/overview${toQueryString({ range: query.range })}`,
  );
}
