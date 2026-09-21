// Phase 16 — platform analytics wrapper.
//
// The numbers come straight from GET /v1/analytics/platform/overview and are
// computed server-side from the play_events stream. This module does NOT
// aggregate, average, or otherwise reinterpret them — the UI displays them
// verbatim.

import type { ApiClient } from './client';
import type { AnalyticsRange, PlatformOverview } from './types';

export function getPlatformOverview(
  client: ApiClient,
  range: AnalyticsRange = '7d',
): Promise<PlatformOverview> {
  return client.get<PlatformOverview>(
    `/v1/analytics/platform/overview?range=${encodeURIComponent(range)}`,
  );
}

/**
 * Phase 17 — artist-scoped overview for the admin console. Same shape as
 * the platform overview, computed server-side. Displayed verbatim.
 */
export function getArtistOverview(
  client: ApiClient,
  artistId: string,
  range: AnalyticsRange = '28d',
): Promise<PlatformOverview> {
  return client.get<PlatformOverview>(
    `/v1/artists/${artistId}/analytics/overview?range=${encodeURIComponent(range)}`,
  );
}
