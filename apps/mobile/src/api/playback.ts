// Phase 7 — playback endpoints against the streaming API.
// Thin wrappers over ApiClient; no business logic lives here. The future
// player (Phase 8+) will call createPlaybackSession to obtain a
// session-scoped HLS URL; no player UI is built in this phase.

import type { ApiClient } from './client';
import type { PlayEventType, PlaybackSession } from './types';

/** Exchange an authenticated call for a short-lived playback session. */
export async function createPlaybackSession(
  api: ApiClient,
  trackId: string,
): Promise<PlaybackSession> {
  return api.post<PlaybackSession>('/v1/playback/sessions', { trackId });
}

/** Record one append-only play event against a session the caller owns. */
export async function reportPlayEvent(
  api: ApiClient,
  sessionId: string,
  type: PlayEventType,
  positionMs?: number,
): Promise<{ id: string }> {
  return api.post<{ id: string }>(
    `/v1/playback/sessions/${encodeURIComponent(sessionId)}/events`,
    positionMs === undefined ? { type } : { type, positionMs },
  );
}
