// Phase 14 — artist audio ingestion API wrappers.
//
// Upload / status / retry for a track's audio pipeline. ARTIST (owner) or
// ADMIN only — the backend enforces roles and ownership; the client sends
// no role logic. Uploads use multipart field "audio" via client.upload(),
// which keeps Bearer injection and the single 401-refresh retry.

import type { ApiClient } from './client';
import type { AudioIngestStatus } from './types';

export interface AudioStatus {
  trackId: string;
  audioStatus: AudioIngestStatus;
  audioError: string | null;
  audioReadyAt: string | null;
}

export interface UploadableAudio {
  uri: string;
  name: string;
  mimeType?: string;
}

/**
 * Upload source audio for an owned track. Returns the ingestion status
 * (PENDING); the server processes in the background. The FormData file
 * entry uses React Native's { uri, name, type } shape — the server
 * re-validates the actual bytes and ignores the declared type.
 */
export function uploadTrackAudio(
  client: ApiClient,
  trackId: string,
  file: UploadableAudio,
): Promise<AudioStatus> {
  const formData = new FormData();
  formData.append('audio', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType ?? 'application/octet-stream',
  } as unknown as Blob);
  return client.upload<AudioStatus>(`/v1/tracks/${trackId}/audio`, formData);
}

/** Current ingestion status for a track (owner/admin only). */
export function getAudioStatus(client: ApiClient, trackId: string): Promise<AudioStatus> {
  return client.get<AudioStatus>(`/v1/tracks/${trackId}/audio`);
}

/** Re-queue a failed ingestion. 409 unless the status is FAILED. */
export function retryTrackAudio(client: ApiClient, trackId: string): Promise<AudioStatus> {
  return client.post<AudioStatus>(`/v1/tracks/${trackId}/audio/retry`);
}
