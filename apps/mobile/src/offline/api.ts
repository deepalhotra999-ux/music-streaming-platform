// Phase 25 — typed wrappers for the offline endpoints. Thin like the
// Phase 7 playback wrappers: no caching, no retries here.

import type { ApiClient } from '../api';
import type { QueuedOfflineEvent, RevalidationResult } from './types';

export interface DownloadGrant {
  authorizationId: string;
  /** Opaque delivery token. Kept in memory only; never persisted. */
  token: string;
  downloadTokenExpiresAt: string;
  expiresAt: string;
  audioVersion: number;
  track: {
    id: string;
    title: string;
    artistName: string;
    albumTitle: string | null;
    durationMs: number;
  };
  /** Relative, token-scoped master playlist URL. Never permanent. */
  downloadUrl: string;
}

export async function authorizeDownload(api: ApiClient, trackId: string): Promise<DownloadGrant> {
  return api.post<DownloadGrant>('/v1/offline/downloads/authorize', { trackId });
}

export async function revalidateDownload(
  api: ApiClient,
  authorizationId: string,
): Promise<RevalidationResult> {
  return api.post<RevalidationResult>(
    `/v1/offline/downloads/${encodeURIComponent(authorizationId)}/revalidate`,
    {},
  );
}

export async function revokeDownload(
  api: ApiClient,
  authorizationId: string,
): Promise<{ id: string; revokedAt: string }> {
  return api.post<{ id: string; revokedAt: string }>(
    `/v1/offline/downloads/${encodeURIComponent(authorizationId)}/revoke`,
    {},
  );
}

export interface OfflineEventSyncResponse {
  accepted: string[];
  rejected: { key: string; reason: string }[];
}

export async function syncOfflineEvents(
  api: ApiClient,
  events: QueuedOfflineEvent[],
): Promise<OfflineEventSyncResponse> {
  return api.post<OfflineEventSyncResponse>('/v1/playback/offline-events', { events });
}
