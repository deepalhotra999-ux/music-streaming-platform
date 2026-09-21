// Phase 8 — playback engine contracts.
//
// UI-agnostic: no React, no expo-audio imports here. The engine
// (PlaybackEngine) owns these contracts; expoAudioDriver adapts expo-audio
// to AudioDriver; the React provider binds engine snapshots to components.
// A future native module (background service, CarPlay, Android Auto) can
// implement AudioDriver or drive PlaybackEngine directly.

import type { TrackSummary } from '../api/types';

/** Engine-level playback state, derived from the driver plus session state. */
export type PlaybackState =
  | 'idle' // nothing loaded
  | 'loading' // session creation or player loading in progress
  | 'buffering' // loaded, but stalled waiting on network
  | 'playing'
  | 'paused'
  | 'error'
  | 'ended'; // last queue track finished naturally

/** One entry in the engine's local queue. */
export interface QueueTrack {
  trackId: string;
  title: string;
  artistName: string;
  albumTitle?: string | null;
  /** Album id, used as the stable seed for placeholder artwork. */
  albumId?: string | null;
  artworkUrl?: string | null;
  /** Catalog duration, informational only; the player reports the true one. */
  durationMs?: number;
}

/** Convert a catalog track summary into a queue entry. */
export function toQueueTrack(summary: TrackSummary): QueueTrack {
  return {
    trackId: summary.id,
    title: summary.title,
    artistName: summary.artistName,
    albumTitle: summary.albumTitle,
    albumId: summary.albumId,
    artworkUrl: null,
    durationMs: summary.durationMs,
  };
}

/** Repeat behavior for natural track end (and next/previous at the edges). */
export type RepeatMode = 'off' | 'all' | 'one';

/** Immutable point-in-time view of the engine, for React and other UIs. */
export interface EngineSnapshot {
  state: PlaybackState;
  queue: QueueTrack[];
  /** Index of the current track, or -1 when nothing is selected. */
  trackIndex: number;
  track: QueueTrack | null;
  positionMs: number;
  /** 0 while the player hasn't reported a duration yet. */
  durationMs: number;
  isBuffering: boolean;
  error: string | null;
  /**
   * Phase 18 — true when the last session creation was denied with
   * "Subscription Required". The track stays in the queue and the UI
   * renders locked playback instead of a generic error.
   */
  locked: boolean;
  canNext: boolean;
  canPrevious: boolean;
  /** Repeat mode; owned by the engine because it controls auto-advance. */
  repeatMode: RepeatMode;
  /** When true, upcoming queue entries were shuffled into play order. */
  shuffle: boolean;
}

/** Driver-level status, mapped 1:1 from the underlying audio player. */
export interface DriverStatus {
  isLoaded: boolean;
  isBuffering: boolean;
  playing: boolean;
  didJustFinish: boolean;
  currentTimeSec: number;
  durationSec: number;
  error: string | null;
}

/**
 * Now-playing metadata published to the OS (lock screen / notification /
 * Control Center) and used as the remote-command target. Phase 10.
 */
export interface NowPlayingMetadata {
  title: string;
  artist?: string | null;
  albumTitle?: string | null;
  /** Remote artwork URL; omitted when the app has no URL artwork. */
  artworkUrl?: string | null;
}

/**
 * Minimal player surface the engine needs. expoAudioDriver implements this
 * over expo-audio; tests use a fake. A future custom native module can
 * implement this interface instead without touching the engine.
 */
export interface AudioDriver {
  /** One-time native setup (audio mode/session). Safe to call repeatedly. */
  initialize(): Promise<void>;
  /**
   * Load a new source, tearing down any previous player first: the driver
   * never keeps two native players alive at once.
   */
  load(uri: string): Promise<void>;
  play(): void;
  pause(): void;
  seekTo(positionMs: number): Promise<void>;
  getStatus(): DriverStatus;
  /** Subscribe to status changes; returns an unsubscribe function. */
  onStatusChange(listener: (status: DriverStatus) => void): () => void;
  /**
   * Publish now-playing metadata to the OS (lock screen / notification)
   * and register this driver as the remote-command target (play/pause/seek
   * where the OS supports it). Passing null clears the OS controls.
   * Replacing the metadata for a new track must supersede the previous
   * registration without an intermediate clear, so background playback is
   * never left without a foreground session. Safe to call repeatedly.
   */
  setNowPlaying(metadata: NowPlayingMetadata | null): void;
  /** Release native resources. */
  destroy(): void;
}

export type EngineListener = (snapshot: EngineSnapshot) => void;
