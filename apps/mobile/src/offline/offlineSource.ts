// Phase 25 — offline playback source resolver.
//
// The single gate for offline playback: a track is playable offline only
// when (a) the SecureStore authorization record is locally valid
// (inside its window, not revoked) AND (b) the assembled media file
// exists. Both checks are fail-closed. The server revalidates on
// reconnect; this gate never extends the window.

import { getAuthorization, isAuthorizationValid } from './authorizationStore';
import type { OfflineAuthorizationRecord } from './types';
import { audioFile, fileExists } from './storage';

export interface OfflineSource {
  uri: string;
  authorization: OfflineAuthorizationRecord;
}

/** Resolve a track to its offline file, or null when not playable offline. */
export async function resolveOfflineSource(trackId: string): Promise<OfflineSource | null> {
  const record = await getAuthorization(trackId);
  if (!record) return null;
  if (!isAuthorizationValid(record)) return null;
  const uri = audioFile(trackId);
  if (!(await fileExists(uri))) return null;
  return { uri, authorization: record };
}

/** Lightweight availability check for UI badges (no playback intent). */
export async function isTrackDownloaded(trackId: string): Promise<boolean> {
  return (await resolveOfflineSource(trackId)) !== null;
}
