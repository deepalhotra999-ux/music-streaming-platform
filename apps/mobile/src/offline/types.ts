// Phase 25 — offline downloads & offline playback. Shared types.

/** Lifecycle of a single track download. */
export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'complete'
  | 'failed'
  /** Server says the pinned version is stale: re-download required. */
  | 'stale'
  /** Server revoked / entitlement lost / takedown: not playable offline. */
  | 'unavailable';

/** Per-track download metadata (AsyncStorage — display/state only, never
 *  authorization). The authorization-critical record lives in SecureStore. */
export interface DownloadRecord {
  trackId: string;
  title: string;
  artistName: string;
  albumTitle: string | null;
  durationMs: number;
  status: DownloadStatus;
  bytesWritten: number;
  /** Server-reported bytes, when known (HLS sizes are not known upfront). */
  totalBytes: number | null;
  /** Next segment index to fetch when resuming (null = from scratch). */
  resumeSegment: number | null;
  authorizationId: string | null;
  /** Audio version the downloaded file was pinned to. */
  audioVersion: number | null;
  error: string | null;
  unavailableReason: string | null;
  updatedAt: string;
}

/**
 * Authorization-critical record (SecureStore — NOT AsyncStorage).
 * Local metadata tampering must not be able to extend authorization:
 * only this record gates offline playback, and it is only ever written
 * from server responses (authorize / revalidate), never from user input.
 */
export interface OfflineAuthorizationRecord {
  authorizationId: string;
  trackId: string;
  audioVersion: number;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** A queued offline play event awaiting upload. */
export interface QueuedOfflineEvent {
  /** Client-generated UUID: the server-side idempotency key. */
  key: string;
  offlineAuthorizationId: string;
  /** Groups the events of one offline playback session (the stream unit). */
  offlineSessionKey: string;
  type: 'START' | 'HEARTBEAT' | 'COMPLETE' | 'ERROR';
  positionMs: number;
  /** When playback actually happened offline. */
  occurredAt: string;
}

export type RevalidationStatus =
  | 'ok'
  | 'expired'
  | 'revoked'
  | 'version_mismatch'
  | 'entitlement_lost'
  | 'entitlement_canceled'
  | 'track_unavailable';

export interface RevalidationResult {
  valid: boolean;
  status: RevalidationStatus;
  expiresAt: string;
  audioVersion: number;
  currentAudioVersion: number | null;
}

export function isTerminalDownloadStatus(status: DownloadStatus): boolean {
  return (
    status === 'complete' || status === 'failed' || status === 'unavailable' || status === 'stale'
  );
}
