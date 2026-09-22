// Phase 23 — CarPlay controller.
//
// The only object that talks to the native CarPlay module. It:
//  - subscribes to native events (connect/disconnect/browse/play/command),
//  - answers them with content from CarPlayContentProvider,
//  - invokes the *existing* PlaybackEngine for every track selection
//    (same queue, same HLS session flow, same telemetry — CarPlay is just
//    another remote control for the one player),
//  - keeps the native now-playing highlight in sync with engine snapshots.
//
// It never plays audio itself, never calls the backend directly, and
// never exposes content outside what the provider (and the server)
// already authorize.

import type { ApiClient } from '../api';
import type { PlaybackEngine } from '../playback/PlaybackEngine';
import type { RepeatMode } from '../playback/types';
import { toQueueTrack } from '../playback/types';
import type {
  CarPlayBrowseRequestEvent,
  CarPlayCommandEvent,
  CarPlayPlayRequestEvent,
} from 'waveform-carplay';
import { CarPlayContentProvider, type CarPlayPlaybackModes } from './contentProvider';
import { trackIdFromItemId } from './identifiers';
import { getCarPlayNativeModule, type CarPlayNativeModule } from './nativeBridge';
import { subscribeEngine } from '../playback/engineRegistry';

export interface CarPlayControllerDeps {
  /** Authenticated client from useAuth(). */
  api: ApiClient;
  /** The single shared engine (PlaybackProvider registry). */
  getEngine: () => PlaybackEngine | null;
}

function nextRepeatMode(mode: RepeatMode): RepeatMode {
  switch (mode) {
    case 'off':
      return 'all';
    case 'all':
      return 'one';
    default:
      return 'off';
  }
}

/** Human message for a failed content/play request. Never leaks internals. */
function messageFor(error: unknown): string {
  if (error instanceof Error && /network|fetch|timeout/i.test(error.message)) {
    return 'Check your connection and try again.';
  }
  return 'This content is unavailable right now.';
}

export class CarPlayController {
  private readonly provider: CarPlayContentProvider;
  private readonly native: CarPlayNativeModule | null;
  private readonly subs: Array<{ remove: () => void }> = [];
  private engineUnsubscribe: (() => void) | null = null;
  private engineRegistryUnsubscribe: (() => void) | null = null;
  private attached = false;

  constructor(
    private readonly deps: CarPlayControllerDeps,
    native?: CarPlayNativeModule | null,
  ) {
    this.provider = new CarPlayContentProvider(deps.api);
    this.native = native === undefined ? getCarPlayNativeModule() : native;
  }

  /** Attach native listeners and announce the signed-in session. Safe to call once. */
  attach(): void {
    if (this.attached || !this.native) {
      return;
    }
    this.attached = true;
    const n = this.native;
    this.subs.push(
      n.addListener('onCarPlayConnect', () => {
        void this.handleConnect();
      }),
      n.addListener('onCarPlayDisconnect', () => this.handleDisconnect()),
      n.addListener('onBrowseRequest', (event: CarPlayBrowseRequestEvent) => {
        void this.handleBrowse(event);
      }),
      n.addListener('onPlayRequest', (event: CarPlayPlayRequestEvent) => {
        void this.handlePlay(event);
      }),
      n.addListener('onCommand', (event: CarPlayCommandEvent) => this.handleCommand(event)),
    );
    // PlaybackProvider may mount (and register the engine) after this host
    // attaches — e.g. cold start straight into the car. When the engine
    // arrives late, pick up the now-playing subscription if CarPlay is
    // already connected.
    this.engineRegistryUnsubscribe = subscribeEngine((engine) => {
      if (engine && n.isCarPlayConnected()) {
        this.subscribeEngineSnapshots();
      }
    });
    n.notifyAuthState(true);
    // The scene may have connected before JS was ready (cold start in the
    // car); in that case push content now instead of waiting for an event.
    if (n.isCarPlayConnected()) {
      void this.handleConnect();
    }
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
    try {
      this.native?.notifyAuthState(false);
    } catch {
      // Best effort on teardown.
    }
  }

  // --- Event handlers --------------------------------------------------------

  private async handleConnect(): Promise<void> {
    const n = this.native;
    if (!n) {
      return;
    }
    try {
      n.setTabs(await this.provider.getTabs(this.playbackModes()));
      this.subscribeEngineSnapshots();
    } catch {
      // Native already falls back to its sign-in gate on a grace timer;
      // surface the failure explicitly so a signed-in user is not misled.
      try {
        n.showAlert("Couldn't load", 'Check your connection and try again.');
      } catch {
        // Best effort.
      }
    }
  }

  private handleDisconnect(): void {
    // Playback belongs to the phone session: disconnecting the car only
    // drops the now-playing highlight subscription. Audio keeps playing.
    if (this.engineUnsubscribe) {
      this.engineUnsubscribe();
      this.engineUnsubscribe = null;
    }
  }

  private async handleBrowse(event: CarPlayBrowseRequestEvent): Promise<void> {
    const n = this.native;
    if (!n) {
      return;
    }
    try {
      const node = await this.provider.getNode(event.nodeId, this.playbackModes());
      n.resolveBrowse(event.requestId, { ok: true, title: node.title, sections: node.sections });
    } catch (error) {
      n.resolveBrowse(event.requestId, {
        ok: false,
        title: "Couldn't load",
        message: messageFor(error),
      });
    }
  }

  private async handlePlay(event: CarPlayPlayRequestEvent): Promise<void> {
    const n = this.native;
    if (!n) {
      return;
    }
    const fail = (title: string, message: string): void => {
      n.resolvePlay(event.requestId, { ok: false, title, message });
    };

    const trackId = trackIdFromItemId(event.itemId);
    const engine = this.deps.getEngine();
    if (!trackId || !engine) {
      fail("Couldn't play", 'This track is unavailable.');
      return;
    }

    // Always refresh the node's tracks before queueing: a track that was
    // playable at browse time may have been taken down or deleted since.
    // Playback session creation remains the final authority, but we fail
    // fast here instead of queueing a stale entry.
    const tracks = await this.safeNodeTracks(event.nodeId, true);
    const index = tracks.findIndex((t) => t.id === trackId);
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
    n.resolvePlay(event.requestId, { ok: true });
  }

  private handleCommand(event: CarPlayCommandEvent): void {
    const engine = this.deps.getEngine();
    if (!engine) {
      return;
    }
    switch (event.command) {
      case 'play':
        engine.play();
        break;
      case 'pause':
        engine.pause();
        break;
      case 'next':
        engine.next();
        break;
      case 'previous':
        engine.previous();
        break;
      case 'shuffle':
        engine.setShuffle(!engine.getSnapshot().shuffle);
        void this.refreshTabs();
        break;
      case 'repeat':
        engine.setRepeatMode(nextRepeatMode(engine.getSnapshot().repeatMode));
        void this.refreshTabs();
        break;
    }
  }

  /** Re-push tabs so Library shuffle/repeat subtitles reflect the new mode. */
  private async refreshTabs(): Promise<void> {
    const n = this.native;
    if (!n) {
      return;
    }
    try {
      n.setTabs(await this.provider.getTabs(this.playbackModes()));
    } catch {
      // Best effort; tabs keep their last good state.
    }
  }

  // --- Helpers ---------------------------------------------------------------

  private async safeNodeTracks(
    nodeId: string,
    refresh = false,
  ): Promise<import('../api/types').TrackSummary[]> {
    try {
      return refresh
        ? await this.provider.refreshNodeTracks(nodeId, this.playbackModes())
        : await this.provider.getNodeTracks(nodeId, this.playbackModes());
    } catch {
      return [];
    }
  }

  private playbackModes(): CarPlayPlaybackModes {
    const snapshot = this.deps.getEngine()?.getSnapshot();
    return {
      shuffle: snapshot?.shuffle ?? false,
      repeatMode: snapshot?.repeatMode ?? 'off',
    };
  }

  /** Mirror engine track changes onto the native now-playing highlight. */
  private subscribeEngineSnapshots(): void {
    const engine = this.deps.getEngine();
    const n = this.native;
    if (!engine || !n || this.engineUnsubscribe) {
      return;
    }
    let lastItemId: string | null | undefined;
    const sync = (): void => {
      const track = engine.getSnapshot().track;
      const itemId = track ? `track:${track.trackId}` : null;
      if (itemId !== lastItemId) {
        lastItemId = itemId;
        try {
          n.updatePlayingItem(itemId);
        } catch {
          // Best effort.
        }
      }
    };
    sync();
    this.engineUnsubscribe = engine.subscribe(sync);
  }
}
