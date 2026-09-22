// Phase 24 — Android Auto controller.
//
// The only object that talks to the native Android Auto module. It:
//  - subscribes to native events (browse/play/command/search),
//  - answers them with content from AndroidAutoContentProvider,
//  - invokes the *existing* PlaybackEngine for every track selection
//    (same queue, same HLS session flow, same telemetry — Android Auto is
//    just another remote control for the one player),
//  - projects engine snapshots onto the native virtual player
//    (playback state, queue, repeat/shuffle).
//
// It never plays audio itself, never calls the backend directly except
// through the provider/search APIs, and never exposes content outside
// what the provider (and the server) already authorize.

import type {
  AutoChildrenRequestEvent,
  AutoCommandEvent,
  AutoItemRequestEvent,
  AutoLibraryRootRequestEvent,
  AutoMediaItemPayload,
  AutoPlayRequestEvent,
  AutoRepeatMode,
  AutoSearchRequestEvent,
} from 'waveform-android-auto';
import type { ApiClient } from '../api';
import type { TrackSummary } from '../api/types';
import type { PlaybackEngine } from '../playback/PlaybackEngine';
import { toQueueTrack, type QueueTrack, type RepeatMode } from '../playback/types';
import { subscribeEngine } from '../playback/engineRegistry';
import { searchCatalog } from '../search/api';
import { AndroidAutoContentProvider } from './contentProvider';
import {
  AUTO_ROOT,
  albumMediaId,
  artistMediaId,
  playlistMediaId,
  trackIdFromMediaId,
} from './identifiers';
import { getAndroidAutoNativeModule, type AndroidAutoNativeModule } from './nativeBridge';

export interface AndroidAutoControllerDeps {
  /** Authenticated client from useAuth(). */
  api: ApiClient;
  /** The single shared engine (PlaybackProvider registry). */
  getEngine: () => PlaybackEngine | null;
}

/** Human message for a failed content/play request. Never leaks internals. */
function messageFor(error: unknown): string {
  if (error instanceof Error && /network|fetch|timeout/i.test(error.message)) {
    return 'Check your connection and try again.';
  }
  return 'This content is unavailable right now.';
}

/** Media3 repeat mode ints (Player.REPEAT_MODE_*). */
function repeatModeFromInt(mode: number | undefined): RepeatMode {
  switch (mode) {
    case 1:
      return 'one';
    case 2:
      return 'all';
    default:
      return 'off';
  }
}

function toAutoRepeatMode(mode: RepeatMode): AutoRepeatMode {
  return mode;
}

function queuePayload(track: QueueTrack): AutoMediaItemPayload {
  return {
    mediaId: `waveform:track:${track.trackId}`,
    title: track.title,
    subtitle: track.artistName,
    browsable: false,
    playable: true,
    durationMs: track.durationMs ?? undefined,
    artworkUrl: track.artworkUrl ?? null,
  };
}

export class AndroidAutoController {
  private readonly provider: AndroidAutoContentProvider;
  private readonly native: AndroidAutoNativeModule | null;
  private readonly subs: Array<{ remove: () => void }> = [];
  private engineUnsubscribe: (() => void) | null = null;
  private engineRegistryUnsubscribe: (() => void) | null = null;
  private attached = false;
  /** Last projected queue signature, to avoid redundant native pushes. */
  private lastQueueSignature: string | null = null;
  private lastModesSignature: string | null = null;

  constructor(
    private readonly deps: AndroidAutoControllerDeps,
    native?: AndroidAutoNativeModule | null,
  ) {
    this.provider = new AndroidAutoContentProvider(deps.api);
    this.native = native === undefined ? getAndroidAutoNativeModule() : native;
  }

  /** Attach native listeners and announce the signed-in session. Safe to call once. */
  attach(): void {
    if (this.attached || !this.native) {
      return;
    }
    this.attached = true;
    const n = this.native;
    this.subs.push(
      n.addListener('onLibraryRootRequest', (event: AutoLibraryRootRequestEvent) => {
        this.handleLibraryRoot(event);
      }),
      n.addListener('onChildrenRequest', (event: AutoChildrenRequestEvent) => {
        void this.handleChildren(event);
      }),
      n.addListener('onItemRequest', (event: AutoItemRequestEvent) => {
        this.handleItem(event);
      }),
      n.addListener('onPlayRequest', (event: AutoPlayRequestEvent) => {
        void this.handlePlay(event);
      }),
      n.addListener('onCommand', (event: AutoCommandEvent) => this.handleCommand(event)),
      n.addListener('onSearchRequest', (event: AutoSearchRequestEvent) => {
        void this.handleSearch(event);
      }),
    );
    // PlaybackProvider may mount (and register the engine) after this host
    // attaches — e.g. cold start straight into the car. When the engine
    // arrives late, pick up the snapshot projection then.
    this.engineRegistryUnsubscribe = subscribeEngine((engine) => {
      if (engine) {
        this.subscribeEngineSnapshots();
      }
    });
    n.notifyAuthState(true);
    // Push the current state immediately: the car may already be connected
    // (cold start), in which case no event will prompt a sync.
    this.subscribeEngineSnapshots();
  }

  /** Remove listeners and tell native the session is gone. Idempotent. */
  detach(): void {
    if (!this.attached) {
      return;
    }
    this.attached = false;
    for (const sub of this.subs.splice(0)) {
      try {
        sub.remove();
      } catch {
        // Listener cleanup must never throw.
      }
    }
    if (this.engineUnsubscribe) {
      this.engineUnsubscribe();
      this.engineUnsubscribe = null;
    }
    if (this.engineRegistryUnsubscribe) {
      this.engineRegistryUnsubscribe();
      this.engineRegistryUnsubscribe = null;
    }
    this.lastQueueSignature = null;
    this.lastModesSignature = null;
    try {
      this.native?.notifyAuthState(false);
    } catch {
      // Best effort on teardown.
    }
  }

  // --- Event handlers --------------------------------------------------------

  private handleLibraryRoot(event: AutoLibraryRootRequestEvent): void {
    try {
      this.native?.resolveLibraryRoot(event.requestId, AUTO_ROOT);
    } catch {
      // Best effort; native times out to its own safe fallback.
    }
  }

  private async handleChildren(event: AutoChildrenRequestEvent): Promise<void> {
    const n = this.native;
    if (!n) {
      return;
    }
    try {
      const result = await this.provider.getChildren(event.parentId, event.page, event.pageSize);
      n.resolveChildren(event.requestId, result);
    } catch (error) {
      n.resolveChildren(event.requestId, { ok: false, items: [] });
      void error;
    }
  }

  private handleItem(event: AutoItemRequestEvent): void {
    try {
      this.native?.resolveItem(event.requestId, this.provider.getAdvertisedItem(event.mediaId));
    } catch {
      // Best effort; native times out to its own safe fallback.
    }
  }

  private async handlePlay(event: AutoPlayRequestEvent): Promise<void> {
    const n = this.native;
    if (!n) {
      return;
    }
    const fail = (title: string, message: string): void => {
      try {
        n.resolvePlay(event.requestId, { ok: false, title, message });
      } catch {
        // Best effort.
      }
    };

    const mediaIds =
      event.mediaIds && event.mediaIds.length > 0
        ? event.mediaIds
        : event.mediaId
          ? [event.mediaId]
          : [];
    const firstTrackId = trackIdFromMediaId(mediaIds[0]);
    const engine = this.deps.getEngine();
    if (!firstTrackId || !engine) {
      fail("Couldn't play", 'This track is unavailable.');
      return;
    }

    // Resolve queue context: which node the tapped track was advertised
    // from. Search taps resolve through the cached search results.
    const tracks = await this.resolvePlayContext(firstTrackId);
    const index = tracks.findIndex((t) => t.id === firstTrackId);
    if (index < 0) {
      fail("Couldn't play", 'This track is no longer available.');
      return;
    }

    try {
      await engine.setQueue(tracks.map(toQueueTrack), index);
    } catch (error) {
      // setQueue can reject (network, session, catalog failures). The
      // native side is waiting on its request timeout; always resolve.
      fail('Playback failed', messageFor(error));
      return;
    }
    const snapshot = engine.getSnapshot();
    if (snapshot.locked) {
      fail(
        'Subscription required',
        'An active subscription is needed to play. Manage it in the Waveform app.',
      );
      return;
    }
    if (snapshot.state === 'error') {
      fail('Playback failed', snapshot.error ?? 'Please try again.');
      return;
    }
    try {
      n.resolvePlay(event.requestId, { ok: true });
    } catch {
      // Best effort.
    }
    // The engine snapshot subscription pushes the new queue + state to
    // native; force an immediate sync so the car UI updates without
    // waiting for the next snapshot tick.
    this.pushSnapshot(true);
  }

  /**
   * Queue context for a tapped track: refresh the node's track listing
   * (takedown safety net, as in Phase 23) or fall back to cached search
   * results for voice-search taps.
   *
   * The cached fallback can be stale (a track taken down after caching),
   * but staleness cannot cause playback: the engine mints a fresh HLS
   * playback session per track at setQueue time, and a taken-down or
   * deleted track fails session creation, landing in the engine error
   * state that handlePlay reports back to the car.
   */
  private async resolvePlayContext(trackId: string): Promise<TrackSummary[]> {
    const nodeId = this.provider.getTrackNodeId(trackId);
    if (nodeId) {
      try {
        return await this.provider.refreshNodeTracks(nodeId);
      } catch {
        return this.provider.getCachedTracks(nodeId) ?? [];
      }
    }
    // Voice-search taps: the track was advertised from a search; use the
    // cached results (the playback session is the final takedown authority).
    for (const query of this.provider.getSearchQueries()) {
      const cached = this.provider.getSearchTracks(query);
      if (cached && cached.some((t) => t.id === trackId)) {
        return cached;
      }
    }
    return [];
  }

  private async handleSearch(event: AutoSearchRequestEvent): Promise<void> {
    const n = this.native;
    if (!n) {
      return;
    }
    const query = event.query.trim();
    if (!query) {
      n.resolveSearch(event.requestId, []);
      return;
    }
    try {
      const results = await searchCatalog(this.deps.api, query, { limitPerCategory: 6 });
      const items: AutoMediaItemPayload[] = [];
      const trackSummaries: TrackSummary[] = [];
      for (const t of results.tracks.items) {
        if (t.status !== 'READY') {
          continue;
        }
        const summary = toTrackSummary(t);
        trackSummaries.push(summary);
        const item: AutoMediaItemPayload = {
          mediaId: `waveform:track:${summary.id}`,
          title: summary.title,
          subtitle: summary.artistName,
          browsable: false,
          playable: true,
          durationMs: summary.durationMs ?? undefined,
          artworkUrl: null,
        };
        items.push(item);
      }
      for (const a of results.albums.items) {
        items.push({
          mediaId: albumMediaId(a.id),
          title: a.title,
          subtitle: a.artistName,
          browsable: true,
          playable: false,
        });
      }
      for (const a of results.artists.items) {
        items.push({
          mediaId: artistMediaId(a.id),
          title: a.name,
          browsable: true,
          playable: false,
        });
      }
      for (const p of results.playlists.items) {
        items.push({
          mediaId: playlistMediaId(p.id),
          title: p.title,
          subtitle: `${p.trackCount} songs`,
          browsable: true,
          playable: false,
        });
      }
      // Remember playable tracks for queue context when one is tapped, and
      // register the items so onGetItem can answer them later.
      this.provider.rememberSearch(query, trackSummaries);
      this.provider.advertiseItems(items);
      n.resolveSearch(event.requestId, items.slice(0, 25));
    } catch {
      n.resolveSearch(event.requestId, []);
    }
  }

  private handleCommand(event: AutoCommandEvent): void {
    const engine = this.deps.getEngine();
    if (!engine) {
      return;
    }
    const snapshot = engine.getSnapshot();
    switch (event.command) {
      case 'play':
        engine.play();
        break;
      case 'pause':
        engine.pause();
        break;
      case 'stop':
        engine.stop();
        break;
      case 'prepare':
        // The engine loads on setQueue; prepare is a no-op-safe ack.
        break;
      case 'next':
        engine.next();
        break;
      case 'previous':
        engine.previous();
        break;
      case 'restart':
        void engine.seekTo(0);
        break;
      case 'seek':
        if (typeof event.positionMs === 'number') {
          void engine.seekTo(Math.max(0, event.positionMs));
        }
        break;
      case 'set-item': {
        const index = event.index ?? 0;
        if (index >= 0 && index < snapshot.queue.length) {
          engine.playAt(index);
          if (typeof event.positionMs === 'number' && event.positionMs > 0) {
            void engine.seekTo(event.positionMs);
          }
        }
        break;
      }
      case 'shuffle':
        engine.setShuffle(typeof event.shuffle === 'boolean' ? event.shuffle : !snapshot.shuffle);
        break;
      case 'repeat':
        engine.setRepeatMode(repeatModeFromInt(event.repeatMode));
        break;
      case 'queue-add':
      case 'queue-move':
      case 'queue-replace':
      case 'queue-remove':
      case 'play-ids':
        // The car host does not offer queue editing in its media UI; these
        // are forwarded for completeness and safely ignored so the engine
        // queue stays the single source of truth.
        break;
    }
  }

  // --- Snapshot projection ---------------------------------------------------

  /** Mirror engine snapshots onto the native virtual player. */
  private subscribeEngineSnapshots(): void {
    const engine = this.deps.getEngine();
    if (!engine || this.engineUnsubscribe) {
      return;
    }
    this.pushSnapshot(true);
    this.engineUnsubscribe = engine.subscribe(() => this.pushSnapshot(false));
  }

  private pushSnapshot(force: boolean): void {
    const n = this.native;
    const engine = this.deps.getEngine();
    if (!n || !engine) {
      return;
    }
    const snapshot = engine.getSnapshot();
    try {
      n.updatePlaybackState({
        state: snapshot.state,
        positionMs: Math.max(0, Math.round(snapshot.positionMs)),
        durationMs: Math.max(0, Math.round(snapshot.durationMs)),
        error: snapshot.state === 'error' ? snapshot.error : null,
        locked: snapshot.locked,
      });
    } catch {
      // Best effort.
    }

    const queueSignature =
      snapshot.queue.map((t) => t.trackId).join(',') + `#${snapshot.trackIndex}`;
    if (force || queueSignature !== this.lastQueueSignature) {
      this.lastQueueSignature = queueSignature;
      try {
        n.updateQueue(snapshot.queue.map(queuePayload), Math.max(0, snapshot.trackIndex));
      } catch {
        // Best effort.
      }
    }

    const modesSignature = `${snapshot.repeatMode}:${snapshot.shuffle}`;
    if (force || modesSignature !== this.lastModesSignature) {
      this.lastModesSignature = modesSignature;
      try {
        n.updateRepeatShuffle(toAutoRepeatMode(snapshot.repeatMode), snapshot.shuffle);
      } catch {
        // Best effort.
      }
    }
  }
}

/** Normalize a search track hit to the TrackSummary shape the queue needs. */
function toTrackSummary(t: {
  id: string;
  title: string;
  durationMs?: number | null;
  status: string;
  artistId: string;
  artistName: string;
  albumId?: string | null;
  albumTitle?: string | null;
}): TrackSummary {
  return {
    id: t.id,
    title: t.title,
    durationMs: t.durationMs ?? 0,
    status: t.status as TrackSummary['status'],
    artistId: t.artistId,
    artistName: t.artistName,
    albumId: t.albumId ?? null,
    albumTitle: t.albumTitle ?? null,
  };
}
