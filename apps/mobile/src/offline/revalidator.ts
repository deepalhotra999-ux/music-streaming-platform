// Phase 25 — server revalidation of offline grants.
//
// Runs when the app has connectivity (app start, reconnect, manual
// refresh). Each grant is revalidated against authoritative server state;
// the local authorization record is updated ONLY from the server
// response. Fail-closed outcomes remove the local authorization so the
// revoked/expired/stale track can never play offline again.
//
// - ok: slide the window (server-provided expiresAt).
// - entitlement_canceled: keep the existing window, never extend it.
// - expired: keep the record but the local gate already blocks playback;
//   the user can re-download (fresh authorize) if entitled again.
// - revoked / entitlement_lost / track_unavailable: delete the local
//   authorization AND the media (fail closed), mark unavailable.
// - version_mismatch: delete the local authorization AND the media; mark
//   stale so the UI offers a re-download of the new version.

import type { ApiClient } from '../api';
import { revalidateDownload } from './api';
import { getAuthorization, removeAuthorization, saveAuthorization } from './authorizationStore';
import { listDownloadIds, updateDownloadRecord } from './metadataStore';
import { deleteTrackDir } from './storage';

export interface RevalidationSummary {
  checked: number;
  renewed: number;
  kept: number;
  invalidated: number;
}

async function invalidate(trackId: string, reason: string): Promise<void> {
  await removeAuthorization(trackId);
  await deleteTrackDir(trackId).catch(() => {});
  await updateDownloadRecord(trackId, {
    status: reason === 'version_mismatch' ? 'stale' : 'unavailable',
    unavailableReason: reason,
    authorizationId: null,
    audioVersion: null,
  });
}

/**
 * Revalidate every locally stored grant. Throws only on network-level
 * failure (caller decides whether to retry); per-grant server rejections
 * are applied, not thrown.
 */
export async function revalidateAll(api: ApiClient): Promise<RevalidationSummary> {
  const summary: RevalidationSummary = { checked: 0, renewed: 0, kept: 0, invalidated: 0 };
  const trackIds = await listDownloadIds();
  for (const trackId of trackIds) {
    const local = await getAuthorization(trackId);
    if (!local) continue;
    summary.checked += 1;
    const result = await revalidateDownload(api, local.authorizationId);
    switch (result.status) {
      case 'ok':
        await saveAuthorization({ ...local, expiresAt: result.expiresAt, revokedAt: null });
        await updateDownloadRecord(trackId, { unavailableReason: null });
        summary.renewed += 1;
        break;
      case 'entitlement_canceled':
        // Existing window respected, never extended: keep the local
        // record exactly as-is.
        summary.kept += 1;
        break;
      case 'expired':
        // The local time gate already blocks playback. Mark unavailable
        // (keeping the file would imply playability); a resubscribed user
        // re-downloads through the normal flow.
        await invalidate(trackId, 'expired');
        summary.invalidated += 1;
        break;
      case 'revoked':
        await invalidate(trackId, 'revoked');
        summary.invalidated += 1;
        break;
      case 'entitlement_lost':
        await invalidate(trackId, 'entitlement_lost');
        summary.invalidated += 1;
        break;
      case 'track_unavailable':
        await invalidate(trackId, 'track_unavailable');
        summary.invalidated += 1;
        break;
      case 'version_mismatch': {
        await invalidate(trackId, 'version_mismatch');
        summary.invalidated += 1;
        break;
      }
    }
  }
  return summary;
}
