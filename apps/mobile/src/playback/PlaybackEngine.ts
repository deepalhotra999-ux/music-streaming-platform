// Phase 8 — PlaybackEngine: the mobile audio engine. Framework-free.
//
// Owns exactly one audio driver (and therefore one native player) at a time,
// one playback session per track, and a local queue. React binds via
// subscribe()/getSnapshot(); future native surfaces (background service,
// CarPlay, Android Auto) can drive this same class without React.
//
// Play-event semantics (see ADR-007):
// - START once per track, when playback actually begins (position 0).
// - HEARTBEAT every heartbeatIntervalMs while the track is active.
// - COMPLETE only when a track plays to its natural end. A manual skip is
//   not a completed play, so the royalty/fraud signal stays clean.
// - ERROR when session creation or playback fails, with the last position.
//   Note: if session creation itself fails there is no session id to report
//   against, so the failure surfaces only as engine error state (and via
//   onEngineError), not as a play event.
//
// Session hygiene: the raw session token is only ever embedded in the HLS
// URL handed to the player; the engine keeps the session id (for events)
// and discards the token. Changing tracks tears down the old player and
// session before the new one loads, so two tracks never play at once.

import {
  ApiClient,
  ApiError,
  apiErrorMessage,
  createPlaybackSession,
  reportPlayEvent,
} from '../api';
import type { PlayEventType } from '../api';
import type {
  AudioDriver,
  DriverStatus,
  EngineListener,
  EngineSnapshot,
  NowPlayingMetadata,
  PlaybackState,
  QueueTrack,
  RepeatMode,
} from './types';

/** Default cadence for HEARTBEAT events while a track is active. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Seeking back within the first seconds of a track restarts it (standard player UX). */
const PREVIOUS_RESTART_THRESHOLD_MS = 3_000;

/** Map a queue entry to the OS now-playing metadata (Phase 10). */
function toNowPlaying(track: QueueTrack): NowPlayingMetadata {
  return {
    title: track.title,
    artist: track.artistName,
    albumTitle: track.albumTitle,
    artworkUrl: track.artworkUrl,
  };
}

/** Phase 25 — offline playback hooks. The engine consults the offline
 *  source BEFORE minting a streaming session; a hit plays the local file
 *  with no network and no playback session. Events for offline playback
 *  are handed to `enqueueEvent` for persisted, idempotent upload later.
 *  The engine still owns exactly one driver/player either way. */
export interface OfflinePlaybackHooks {
  resolveTrack: (trackId: string) => Promise<{
    uri: string;
    authorizationId: string;
    audioVersion: number;
  } | null>;
  enqueueEvent: (event: {
    offlineAuthorizationId: string;
    offlineSessionKey: string;
    type: PlayEventType;
    positionMs: number;
  }) => void;
}

export interface PlaybackEngineOptions {
  api: ApiClient;
  /** API origin, e.g. getApiBaseUrl(). Session hlsUrl values are relative. */
  baseUrl: string;
  driver: AudioDriver;
  /** Override for tests. Defaults to HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs?: number;
  /** Optional diagnostics hook; the engine never throws from event paths. */
  onEngineError?: (error: unknown, context: string) => void;
  /** Phase 25 — when omitted, the engine is online-only (previous behavior). */
  offline?: OfflinePlaybackHooks;
}

/** Non-cryptographic grouping key for one offline playback session. */
function newOfflineSessionKey(): string {
  return `off-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface ActiveSession {
  id: string;
  trackId: string;
}

export class PlaybackEngine {
  private readonly api: ApiClient;
  private readonly baseUrl: string;
  private readonly driver: AudioDriver;
  private readonly heartbeatIntervalMs: number;
  private readonly onEngineError: (error: unknown, context: string) => void;

  private queue: QueueTrack[] = [];
  private trackIndex = -1;
  private session: ActiveSession | null = null;
  private state: PlaybackState = 'idle';
  private positionMs = 0;
  private durationMs = 0;
  private isBuffering = false;
  private error: string | null = null;
  /** Phase 18 — set when playback is denied for lack of subscription. */
  private locked = false;
  private repeatMode: RepeatMode = 'off';
  private shuffle = false;

  private startedReported = false;
  private finishedNaturally = false;
  private pendingSeekMs: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeDriver: (() => void) | null = null;
  /** Bumps on every load; stale async loads abort instead of clobbering. */
  private loadGeneration = 0;
  private initialized = false;

  private readonly listeners = new Set<EngineListener>();
  private readonly offline?: OfflinePlaybackHooks;
  /**
   * Phase 28 — when true, offline source resolution is skipped and every
   * track load mints a fresh streaming session. Room mode sets this so
   * each listener keeps ordinary Phase 7 session/event/royalty semantics;
   * ordinary personal offline playback outside rooms is unchanged.
   */
  private forceOnline = false;
  /**
   * Phase 25 — set when the current track plays from an offline download.
   * Replaces `session` for event attribution; cleared on teardown.
   */
  private offlineContext: { authorizationId: string; sessionKey: string } | null = null;

  constructor(options: PlaybackEngineOptions) {
    this.api = options.api;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.driver = options.driver;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.onEngineError = options.onEngineError ?? (() => undefined);
    this.offline = options.offline;
  }

  /** One-time native audio-mode setup. Called by the provider on mount. */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    await this.driver.initialize();
  }

  // -- subscriptions -------------------------------------------------------

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): EngineSnapshot {
    const track = this.trackIndex >= 0 ? (this.queue[this.trackIndex] ?? null) : null;
    return {
      state: this.state,
      queue: this.queue.slice(),
      trackIndex: this.trackIndex,
      track,
      positionMs: this.positionMs,
      durationMs: this.durationMs,
      isBuffering: this.isBuffering,
      error: this.error,
      locked: this.locked,
      // Phase 25 — true when the current track plays from a local
      // download (no streaming session, events queued for later upload).
      isOfflinePlayback: this.offlineContext !== null,
      // With repeat-all the edges wrap, so next/previous stay available
      // at the end/head of the queue.
      canNext:
        this.trackIndex >= 0 &&
        (this.trackIndex < this.queue.length - 1 ||
          (this.repeatMode === 'all' && this.queue.length > 1)),
      canPrevious:
        this.trackIndex > 0 ||
        (this.trackIndex === 0 && this.repeatMode === 'all' && this.queue.length > 1),
      repeatMode: this.repeatMode,
      shuffle: this.shuffle,
    };
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  // -- queue ---------------------------------------------------------------

  /** Replace the queue and start playing at startIndex. */
  async setQueue(tracks: QueueTrack[], startIndex = 0): Promise<void> {
    this.queue = tracks.slice();
    if (this.queue.length === 0) {
      this.stop();
      return;
    }
    const index = Math.min(Math.max(0, startIndex), this.queue.length - 1);
    await this.loadTrackAt(index, { autoplay: true });
  }

  /** Append a track to the end of the queue. */
  enqueue(track: QueueTrack): void {
    this.queue = [...this.queue, track];
    this.emit();
  }

  /** Stop playback and drop the queue. */
  clearQueue(): void {
    this.queue = [];
    this.stop();
  }

  /**
   * Remove the queue entry at index. Removing the current track continues
   * with the track that slid into its place (or stops when the queue runs
   * out). Out-of-range indices are ignored.
   */
  removeAt(index: number): void {
    if (index < 0 || index >= this.queue.length) {
      return;
    }
    this.queue.splice(index, 1);
    if (index === this.trackIndex) {
      if (index < this.queue.length) {
        // The next track slid into this slot. loadTrackAt bumps the load
        // generation, invalidating an in-flight load of the removed track.
        void this.loadTrackAt(index, { autoplay: true });
      } else {
        this.stop();
      }
      return;
    }
    if (index < this.trackIndex) {
      this.trackIndex -= 1;
    }
    this.emit();
  }

  /** Start playing the queue entry at index. Out-of-range indices are ignored. */
  playAt(index: number): void {
    if (index < 0 || index >= this.queue.length) {
      return;
    }
    void this.loadTrackAt(index, { autoplay: true });
  }

  /** Repeat mode for natural track end and edge next/previous. */
  setRepeatMode(mode: RepeatMode): void {
    if (this.repeatMode !== mode) {
      this.repeatMode = mode;
      this.emit();
    }
  }

  /**
   * Phase 28 — force every track load to mint a streaming session instead
   * of resolving a local offline download. Room mode enables this on join
   * and disables it on leave; it never affects loads already in flight.
   */
  setForceOnline(force: boolean): void {
    this.forceOnline = force;
  }

  /**
   * Shuffle the upcoming queue entries (everything after the current
   * track) into a random play order. Already-played entries and the
   * current track stay in place, so previous-track history still makes
   * sense. Turning shuffle off keeps the current order.
   */
  setShuffle(enabled: boolean): void {
    if (this.shuffle === enabled) {
      return;
    }
    this.shuffle = enabled;
    if (enabled) {
      // Fisher–Yates over the upcoming slice only.
      for (let i = this.queue.length - 1; i > this.trackIndex + 1; i -= 1) {
        const j = this.trackIndex + 1 + Math.floor(Math.random() * (i - this.trackIndex));
        const a = this.queue[i];
        const b = this.queue[j];
        if (a !== undefined && b !== undefined) {
          this.queue[i] = b;
          this.queue[j] = a;
        }
      }
    }
    this.emit();
  }

  // -- transport controls ----------------------------------------------------

  play(): void {
    if (this.state === 'error') {
      // Recovering from an error means a fresh session at the last position.
      void this.retry();
      return;
    }
    if (this.trackIndex < 0) {
      if (this.queue.length > 0) {
        void this.loadTrackAt(0, { autoplay: true });
      }
      return;
    }
    if (this.state === 'ended' || this.state === 'idle') {
      void this.loadTrackAt(this.trackIndex, { autoplay: true });
      return;
    }
    // Paused (or still loading): resume. Harmless if already playing.
    this.driver.play();
  }

  pause(): void {
    if (this.state === 'playing' || this.state === 'buffering') {
      this.stopHeartbeat();
      this.driver.pause();
      this.setState('paused');
      this.emit();
    }
  }

  toggle(): void {
    if (this.state === 'playing' || this.state === 'buffering') {
      this.pause();
    } else {
      this.play();
    }
  }

  /** Full stop: invalidate pending loads, release the player and session, keep the queue. */
  stop(): void {
    this.invalidatePendingLoads();
    this.teardownTrack();
    this.trackIndex = -1;
    this.locked = false;
    this.setState('idle');
    this.emit();
  }

  /** Release everything (app teardown). The engine must not be used after. */
  destroy(): void {
    this.invalidatePendingLoads();
    this.teardownTrack();
    this.queue = [];
    this.trackIndex = -1;
    this.listeners.clear();
    this.setState('idle');
  }

  async seekTo(positionMs: number): Promise<void> {
    if (this.trackIndex < 0) {
      return;
    }
    const clamped = Math.max(
      0,
      this.durationMs > 0 ? Math.min(positionMs, this.durationMs) : positionMs,
    );
    this.positionMs = Math.round(clamped);
    if (this.driver.getStatus().isLoaded) {
      try {
        await this.driver.seekTo(this.positionMs);
      } catch (error) {
        this.fail(apiErrorMessage(error));
        return;
      }
    } else {
      // Not loaded yet (e.g. seek during 'loading'): apply once it is.
      this.pendingSeekMs = this.positionMs;
    }
    this.emit();
  }

  next(): void {
    if (this.trackIndex < 0) {
      return;
    }
    if (this.trackIndex < this.queue.length - 1) {
      void this.loadTrackAt(this.trackIndex + 1, { autoplay: true });
      return;
    }
    if (this.repeatMode === 'all' && this.queue.length > 1) {
      // Repeat-all wraps next() at the end of the queue back to the start.
      void this.loadTrackAt(0, { autoplay: true });
    }
  }

  previous(): void {
    if (this.trackIndex < 0) {
      return;
    }
    if (this.positionMs > PREVIOUS_RESTART_THRESHOLD_MS) {
      void this.seekTo(0);
      return;
    }
    if (this.trackIndex === 0) {
      if (this.repeatMode === 'all' && this.queue.length > 1) {
        // Repeat-all wraps previous() at the head of the queue to the end.
        void this.loadTrackAt(this.queue.length - 1, { autoplay: true });
      } else {
        // Standard UX: restart the current track (nothing to go back to).
        void this.seekTo(0);
      }
      return;
    }
    void this.loadTrackAt(this.trackIndex - 1, { autoplay: true });
  }

  /**
   * Recover from a network interruption or playback error: mint a fresh
   * playback session for the current track and resume at the last position.
   */
  async retry(): Promise<void> {
    if (this.trackIndex < 0) {
      return;
    }
    await this.loadTrackAt(this.trackIndex, {
      autoplay: true,
      resumeMs: this.positionMs,
    });
  }

  // -- track loading ---------------------------------------------------------

  private async loadTrackAt(
    index: number,
    opts: { autoplay: boolean; resumeMs?: number },
  ): Promise<void> {
    const track = this.queue[index];
    if (!track) {
      return;
    }
    const generation = ++this.loadGeneration;
    // Tear down first: the old player and session are gone before the new
    // session is even requested, so two tracks can never play at once.
    this.teardownTrack();
    this.trackIndex = index;
    this.error = null;
    this.locked = false;
    this.setState('loading');
    this.emit();

    let sessionId: string | null = null;
    let mediaUri: string;
    // Phase 25 — offline first: a valid local download plays with no
    // network and no streaming session. The authorization gate lives in
    // resolveTrack (SecureStore record + file existence, fail-closed).
    // Phase 28 — forceOnline (room mode) skips this entirely so every
    // listener mints an ordinary Phase 7 streaming session.
    const offlineSource =
      this.offline && !this.forceOnline
        ? await this.offline.resolveTrack(track.trackId).catch(() => null)
        : null;
    if (generation !== this.loadGeneration) {
      return; // superseded while resolving the offline source
    }
    if (offlineSource) {
      this.offlineContext = {
        authorizationId: offlineSource.authorizationId,
        sessionKey: newOfflineSessionKey(),
      };
      mediaUri = offlineSource.uri;
    } else {
      this.offlineContext = null;
      try {
        const session = await createPlaybackSession(this.api, track.trackId);
        sessionId = session.id;
        // ADR-006: hlsUrl is a relative, session-scoped path. Resolve it
        // against the API origin. The raw token lives only inside this URL.
        mediaUri = `${this.baseUrl}${session.hlsUrl}`;
      } catch (error) {
        if (generation !== this.loadGeneration) {
          return; // superseded by a newer load (or stop/destroy)
        }
        // Phase 18 — subscription denial is a distinct locked state, not a
        // generic playback error. The track stays queued; the UI offers the
        // subscription screen instead of a retry.
        if (error instanceof ApiError && error.isSubscriptionRequired) {
          this.locked = true;
        }
        this.fail(apiErrorMessage(error));
        return;
      }
      if (generation !== this.loadGeneration) {
        return; // superseded while the session was minted
      }
      this.session = { id: sessionId, trackId: track.trackId };
    }
    // Set the resume target BEFORE load: the driver publishes its initial
    // status synchronously during load(), so a later assignment would be
    // missed by handleDriverStatus. A user seek issued while the session
    // was being minted already set pendingSeekMs — don't clobber it.
    if (opts.resumeMs !== undefined && opts.resumeMs > 0) {
      this.pendingSeekMs = Math.round(opts.resumeMs);
    }
    try {
      this.unsubscribeDriver = this.driver.onStatusChange((status) =>
        this.handleDriverStatus(status),
      );
      await this.driver.load(mediaUri);
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.fail(apiErrorMessage(error));
      return;
    }
    if (generation !== this.loadGeneration) {
      return;
    }
    // Register for lock-screen / system controls with this track's
    // metadata before playback starts, so the OS surface is correct from
    // the first frame — including when the app is backgrounded.
    this.driver.setNowPlaying(toNowPlaying(track));
    if (opts.autoplay) {
      this.driver.play();
    }
    this.emit();
  }

  /**
   * Release the player, session, and timers for the current track.
   * Does NOT bump the load generation: callers that start a new load do
   * that themselves; stop()/destroy() bump it to abort in-flight loads.
   */
  private teardownTrack(): void {
    this.stopHeartbeat();
    this.unsubscribeDriver?.();
    this.unsubscribeDriver = null;
    // Clear the OS now-playing surface before releasing the player: the
    // track is genuinely gone during the load gap (a new registration
    // follows in loadTrackAt). Skipped when no track was ever registered.
    // The driver destroys the native player: no second instance survives.
    // Phase 25 — offline playback registers now-playing too; clear it the same.
    if (this.session || this.offlineContext) {
      this.driver.setNowPlaying(null);
    }
    this.driver.destroy();
    this.session = null;
    this.offlineContext = null;
    this.startedReported = false;
    this.finishedNaturally = false;
    this.pendingSeekMs = null;
    this.positionMs = 0;
    this.durationMs = 0;
    this.isBuffering = false;
  }

  /**
   * Called by stop()/destroy() so an in-flight loadTrackAt (awaiting session
   * creation or driver.load) sees a stale generation and aborts instead of
   * finishing after the stop.
   */
  private invalidatePendingLoads(): void {
    this.loadGeneration += 1;
  }

  // -- driver status ---------------------------------------------------------

  private handleDriverStatus(status: DriverStatus): void {
    // Phase 25 — offline playback has no streaming session; the offline
    // context is the equivalent "a track is loaded" signal.
    if (!this.session && !this.offlineContext) {
      return; // stale update from a torn-down track
    }
    this.positionMs = Math.max(0, Math.round(status.currentTimeSec * 1000));
    this.durationMs = Math.max(0, Math.round(status.durationSec * 1000));
    this.isBuffering = status.isBuffering;

    if (status.error) {
      this.fail(status.error);
      return;
    }

    if (this.pendingSeekMs !== null && status.isLoaded) {
      const ms = this.pendingSeekMs;
      this.pendingSeekMs = null;
      this.driver.seekTo(ms).catch((error: unknown) => {
        this.fail(apiErrorMessage(error));
      });
    }

    if (status.didJustFinish && !this.finishedNaturally) {
      this.finishedNaturally = true;
      void this.onTrackEnded();
      return;
    }

    if (status.playing) {
      if (!this.startedReported) {
        this.startedReported = true;
        this.setState(status.isBuffering ? 'buffering' : 'playing');
        this.emit();
        this.reportEvent('START', 0);
      } else {
        this.setState(status.isBuffering ? 'buffering' : 'playing');
        this.emit();
      }
      // Resume the cadence after a pause (pause() stops the timer).
      this.ensureHeartbeat();
      return;
    }

    if (!status.isLoaded) {
      this.setState('loading');
    } else {
      // Loaded but not playing: paused, or pre-play right after load.
      // The heartbeat follows actual playback: a native-initiated pause
      // (interruption, headphone unplug, remote pause, audio-focus loss)
      // stops the cadence just like engine.pause() does, and the playing
      // branch above restarts it on resume.
      this.stopHeartbeat();
      this.setState(this.startedReported ? 'paused' : 'loading');
    }
    this.emit();
  }

  private async onTrackEnded(): Promise<void> {
    this.stopHeartbeat();
    const finalPosition = this.positionMs;
    this.reportEvent('COMPLETE', finalPosition);
    if (this.repeatMode === 'one' && this.trackIndex >= 0) {
      // Repeat-one replays the same track with a fresh session.
      await this.loadTrackAt(this.trackIndex, { autoplay: true });
      return;
    }
    if (this.trackIndex >= 0 && this.trackIndex < this.queue.length - 1) {
      await this.loadTrackAt(this.trackIndex + 1, { autoplay: true });
      return;
    }
    if (this.repeatMode === 'all' && this.queue.length > 0) {
      // Repeat-all wraps the end of the queue back to the start.
      await this.loadTrackAt(0, { autoplay: true });
      return;
    }
    // Queue exhausted: release the player, keep the queue for replay.
    this.teardownTrack();
    this.setState('ended');
    this.emit();
  }

  private fail(message: string): void {
    this.stopHeartbeat();
    this.error = message;
    this.setState('error');
    this.emit();
    // Phase 25 — reportEvent routes to the offline queue when an offline
    // context is active, and no-ops when nothing is attributed. Calling it
    // unconditionally keeps ERROR telemetry for both paths.
    this.reportEvent('ERROR', this.positionMs);
  }

  // -- play events -----------------------------------------------------------

  /** Start the heartbeat cadence if it is not already running. */
  private ensureHeartbeat(): void {
    // Phase 25 — heartbeats run for streaming sessions AND offline
    // playback (offline events queue locally until sync).
    const attributed = this.session !== null || this.offlineContext !== null;
    if (this.heartbeatTimer !== null || !attributed || this.finishedNaturally) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      if ((this.session || this.offlineContext) && !this.finishedNaturally) {
        this.reportEvent('HEARTBEAT', this.positionMs);
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Fire-and-forget: telemetry failures must never break playback. */
  private reportEvent(type: PlayEventType, positionMs: number): void {
    const pos = Math.max(0, Math.round(positionMs));
    // Phase 25 — offline playback attributes to the offline session
    // context; events are queued locally for idempotent upload later.
    if (this.offlineContext && this.offline) {
      try {
        this.offline.enqueueEvent({
          offlineAuthorizationId: this.offlineContext.authorizationId,
          offlineSessionKey: this.offlineContext.sessionKey,
          type,
          positionMs: pos,
        });
      } catch (error) {
        this.onEngineError(error, `enqueueOfflineEvent(${type})`);
      }
      return;
    }
    const session = this.session;
    if (!session) {
      return;
    }
    reportPlayEvent(this.api, session.id, type, pos).catch((error: unknown) => {
      this.onEngineError(error, `reportPlayEvent(${type})`);
    });
  }

  private setState(state: PlaybackState): void {
    this.state = state;
  }
}
