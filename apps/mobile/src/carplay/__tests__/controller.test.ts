// Phase 23 — CarPlayController unit tests.
//
// The native module is injected as a deterministic fake (same event names
// and function surface as the Swift module). The engine is a minimal fake
// implementing the controller's slice of PlaybackEngine; the catalog is a
// real ApiClient over stubbed fetch. Pins:
//  - attach announces auth, pushes tabs on connect, is idempotent,
//  - cold-start connect (already connected at attach) pushes tabs,
//  - browse answers resolveBrowse with content or a safe error,
//  - play queues the node's playable tracks at the tapped index and
//    resolves ok; missing/takedown tracks fail safe,
//  - locked (subscription-required) snapshots resolve with the
//    subscription message, never as a generic error,
//  - transport/mode commands reach the engine (never a second player),
//  - engine track changes drive updatePlayingItem,
//  - detach removes listeners and announces sign-out (native sign-in gate).

import { ApiClient } from '../../api/client';
import type { TrackSummary } from '../../api/types';
import type { EngineSnapshot } from '../../playback/types';
import { toQueueTrack, type QueueTrack } from '../../playback/types';
import type {
  CarPlayBrowseRequestEvent,
  CarPlayCommandEvent,
  CarPlayPlayRequestEvent,
} from 'waveform-carplay';
import { CarPlayController } from '../controller';
import { setActiveEngine } from '../../playback/engineRegistry';

// -- fake native module ------------------------------------------------------

interface ListenerMap {
  onCarPlayConnect: Array<() => void>;
  onCarPlayDisconnect: Array<() => void>;
  onBrowseRequest: Array<(e: CarPlayBrowseRequestEvent) => void>;
  onPlayRequest: Array<(e: CarPlayPlayRequestEvent) => void>;
  onCommand: Array<(e: CarPlayCommandEvent) => void>;
}

function createFakeNative() {
  const listeners: ListenerMap = {
    onCarPlayConnect: [],
    onCarPlayDisconnect: [],
    onBrowseRequest: [],
    onPlayRequest: [],
    onCommand: [],
  };
  const calls: { name: string; args: unknown[] }[] = [];
  const removed: Array<() => void> = [];

  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args });
  };

  const fake = {
    calls,
    listeners,
    removedCount: () => removed.length,
    isConnected: false,
    isCarPlayConnected: () => fake.isConnected,
    notifyAuthState: (signedIn: boolean) => record('notifyAuthState', signedIn),
    setTabs: (tabs: unknown) => record('setTabs', tabs),
    resolveBrowse: (requestId: string, result: unknown) =>
      record('resolveBrowse', requestId, result),
    resolvePlay: (requestId: string, result: unknown) => record('resolvePlay', requestId, result),
    updatePlayingItem: (itemId: string | null) => record('updatePlayingItem', itemId),
    showAlert: (title: string, message: string) => record('showAlert', title, message),
    addListener: (event: keyof ListenerMap, handler: (...args: never[]) => void) => {
      (listeners[event] as Array<(...args: never[]) => void>).push(handler);
      return {
        remove: () => {
          removed.push(handler as () => void);
        },
      };
    },
    emit<K extends keyof ListenerMap>(event: K, payload: unknown) {
      for (const handler of listeners[event]) {
        (handler as (p: unknown) => void)(payload);
      }
    },
    lastCall: (name: string) => [...calls].reverse().find((c) => c.name === name),
  };
  return fake;
}

// -- fake engine (the controller's slice of PlaybackEngine) ------------------

function baseSnapshot(): EngineSnapshot {
  return {
    state: 'idle',
    queue: [],
    trackIndex: -1,
    track: null,
    positionMs: 0,
    durationMs: 0,
    isBuffering: false,
    error: null,
    locked: false,
    canNext: false,
    canPrevious: false,
    repeatMode: 'off',
    shuffle: false,
  };
}

function createFakeEngine(overrides: Partial<EngineSnapshot> = {}) {
  const calls: string[] = [];
  let snapshot: EngineSnapshot = { ...baseSnapshot(), ...overrides };
  const subs = new Set<() => void>();

  const engine = {
    calls,
    setSnapshot(next: Partial<EngineSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const sub of subs) sub();
    },
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    next: () => calls.push('next'),
    previous: () => calls.push('previous'),
    setShuffle: (v: boolean) => {
      calls.push(`setShuffle:${v}`);
      engine.setSnapshot({ shuffle: v });
    },
    setRepeatMode: (m: string) => {
      calls.push(`setRepeatMode:${m}`);
      engine.setSnapshot({ repeatMode: m as EngineSnapshot['repeatMode'] });
    },
    setQueue: async (tracks: QueueTrack[], startIndex = 0) => {
      calls.push(`setQueue:${tracks.length}:${startIndex}`);
      engine.setSnapshot({
        queue: tracks,
        trackIndex: startIndex,
        track: tracks[startIndex] ?? null,
      });
    },
  };
  return engine;
}

// -- stub transport -----------------------------------------------------------

function track(id: string): TrackSummary {
  return {
    id,
    title: `Track ${id}`,
    durationMs: 180000,
    status: 'READY',
    artistId: 'artist1',
    artistName: 'Artist One',
    albumId: 'album1',
    albumTitle: 'Album One',
  };
}

function page<T>(data: T[]) {
  return {
    status: 200,
    ok: true,
    json: async () => ({
      data,
      pagination: { page: 1, limit: 50, total: data.length, totalPages: 1 },
    }),
  };
}

function createApi(): ApiClient {
  return new ApiClient({
    baseUrl: 'http://test.local',
    fetchFn: (async (url: string) => {
      if (url.includes('/v1/me/history')) {
        return page([
          {
            id: 'h1',
            trackId: 't1',
            playedAt: 'x',
            progressMs: 0,
            completed: true,
            track: track('t1'),
          },
          {
            id: 'h2',
            trackId: 't2',
            playedAt: 'x',
            progressMs: 0,
            completed: true,
            track: track('t2'),
          },
        ]);
      }
      return page([]);
    }) as typeof fetch,
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// -- tests --------------------------------------------------------------------

describe('CarPlayController', () => {
  test('attach announces auth and pushes tabs on connect; detach signs out', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );

    controller.attach();
    controller.attach(); // idempotent
    expect(native.lastCall('notifyAuthState')?.args).toEqual([true]);
    expect(native.listeners.onCarPlayConnect).toHaveLength(1);

    native.emit('onCarPlayConnect', undefined as never);
    await flush();
    const setTabs = native.lastCall('setTabs');
    expect(setTabs).toBeDefined();
    const tabs = setTabs!.args[0] as Array<{ nodeId: string }>;
    expect(tabs.map((t) => t.nodeId)).toEqual(['home', 'library', 'artists', 'playlists']);

    controller.detach();
    expect(native.lastCall('notifyAuthState')?.args).toEqual([false]);
    expect(native.removedCount()).toBe(5);
  });

  test('already-connected at attach pushes tabs immediately (cold start)', async () => {
    const native = createFakeNative();
    native.isConnected = true;
    const engine = createFakeEngine();
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );

    controller.attach();
    await flush();
    expect(native.lastCall('setTabs')).toBeDefined();
    controller.detach();
  });

  test('browse resolves with node content; unknown node resolves an error', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );
    controller.attach();

    native.emit('onBrowseRequest', { requestId: 'b1', nodeId: 'home' });
    await flush();
    const ok = native.lastCall('resolveBrowse');
    expect(ok?.args[0]).toBe('b1');
    expect(ok?.args[1]).toMatchObject({ ok: true, title: 'Home' });

    native.emit('onBrowseRequest', { requestId: 'b2', nodeId: 'nope' });
    await flush();
    const err = native.lastCall('resolveBrowse');
    expect(err?.args).toEqual([
      'b2',
      { ok: false, title: "Couldn't load", message: expect.any(String) },
    ]);

    controller.detach();
  });

  test('play queues the node tracks at the tapped index and resolves ok', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );
    controller.attach();

    // Browse first so the node has cached queue context.
    native.emit('onBrowseRequest', { requestId: 'b1', nodeId: 'home' });
    await flush();
    native.emit('onPlayRequest', { requestId: 'p1', itemId: 'track:t2', nodeId: 'home' });
    await flush();

    expect(engine.calls).toContain('setQueue:2:1');
    const snapshot = engine.getSnapshot();
    expect(snapshot.track).toMatchObject({ trackId: 't2' });
    expect(native.lastCall('resolvePlay')?.args).toEqual(['p1', { ok: true }]);
    controller.detach();
  });

  test('play of a removed track re-fetches and fails safe', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );
    controller.attach();

    native.emit('onBrowseRequest', { requestId: 'b1', nodeId: 'home' });
    await flush();
    // Track was taken down after browse: not in the (re-fetched) node.
    native.emit('onPlayRequest', { requestId: 'p1', itemId: 'track:gone', nodeId: 'home' });
    await flush();

    expect(engine.calls.filter((c) => c.startsWith('setQueue'))).toHaveLength(0);
    expect(native.lastCall('resolvePlay')?.args).toEqual([
      'p1',
      { ok: false, title: "Couldn't play", message: 'This track is no longer available.' },
    ]);
    controller.detach();
  });

  test('locked engine resolves the subscription message (server-authoritative)', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    // Engine accepts the queue, then the session 403 locks it (Phase 18).
    const queued = engine.setQueue.bind(engine);
    (engine as { setQueue: unknown }).setQueue = async (tracks: QueueTrack[], i = 0) => {
      await queued(tracks, i);
      engine.setSnapshot({ locked: true, state: 'error', error: 'Subscription Required' });
    };
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );
    controller.attach();

    native.emit('onBrowseRequest', { requestId: 'b1', nodeId: 'home' });
    await flush();
    native.emit('onPlayRequest', { requestId: 'p1', itemId: 'track:t1', nodeId: 'home' });
    await flush();

    expect(native.lastCall('resolvePlay')?.args).toEqual([
      'p1',
      {
        ok: false,
        title: 'Subscription required',
        message: expect.stringContaining('subscription'),
      },
    ]);
    controller.detach();
  });

  test('commands reach the one engine; shuffle/repeat toggle current modes', () => {
    const native = createFakeNative();
    const engine = createFakeEngine({ shuffle: false, repeatMode: 'off' });
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );
    controller.attach();

    const commands: CarPlayCommandEvent['command'][] = [
      'play',
      'pause',
      'next',
      'previous',
      'shuffle',
      'repeat',
      'repeat',
      'repeat',
    ];
    for (const command of commands) {
      native.emit('onCommand', { command });
    }

    expect(engine.calls).toEqual([
      'play',
      'pause',
      'next',
      'previous',
      'setShuffle:true',
      'setRepeatMode:all',
      'setRepeatMode:one',
      'setRepeatMode:off',
    ]);
    controller.detach();
  });

  test('engine track changes drive updatePlayingItem; disconnect clears the subscription', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );
    controller.attach();
    native.emit('onCarPlayConnect', undefined as never);
    await flush();

    await engine.setQueue([toQueueTrack(track('t1')), toQueueTrack(track('t2'))], 0);
    await flush();
    expect(native.lastCall('updatePlayingItem')?.args).toEqual(['track:t1']);

    native.emit('onCarPlayDisconnect', undefined as never);
    const callsBefore = native.calls.length;
    engine.setSnapshot({ track: toQueueTrack(track('t2')) });
    await flush();
    // No new updatePlayingItem after disconnect; audio is untouched.
    expect(native.calls.length).toBe(callsBefore);
    expect(engine.calls).not.toContain('pause');
    controller.detach();
  });

  test('no native module: attach is a no-op and nothing throws', () => {
    const controller = new CarPlayController(
      {
        api: createApi(),
        getEngine: () => null,
      },
      null,
    );
    expect(() => {
      controller.attach();
      controller.detach();
    }).not.toThrow();
  });

  test('setQueue rejection resolves the play request with a safe error (never hangs)', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    // Simulate a session/network failure inside setQueue.
    engine.setQueue = async () => {
      throw new Error('network timeout');
    };
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );
    controller.attach();

    native.emit('onPlayRequest', {
      requestId: 'play-1',
      nodeId: 'home',
      itemId: 'track:t1',
    } as never);
    await flush();
    await flush();

    const resolved = native.lastCall('resolvePlay');
    expect(resolved).toBeDefined();
    expect(resolved!.args[0]).toBe('play-1');
    const result = resolved!.args[1] as { ok: boolean; message?: string };
    expect(result.ok).toBe(false);
    // Human message, no internals leaked.
    expect(result.message).toBe('Check your connection and try again.');
    controller.detach();
  });

  test('track taken down between browse and tap fails safe', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    // First the track exists (browse populates the cache), then it is
    // gone on the always-refresh before queueing.
    let gone = false;
    const api = new ApiClient({
      baseUrl: 'http://test.local',
      fetchFn: (async (url: string) => {
        if (url.includes('/v1/me/history')) {
          if (gone) {
            return page([]);
          }
          return page([
            {
              id: 'h1',
              trackId: 't1',
              playedAt: 'x',
              progressMs: 0,
              completed: true,
              track: track('t1'),
            },
          ]);
        }
        return page([]);
      }) as typeof fetch,
    });
    const controller = new CarPlayController(
      { api, getEngine: () => engine as never },
      native as never,
    );
    controller.attach();

    // Browse the home node to populate the cache with t1.
    native.emit('onBrowseRequest', { requestId: 'b1', nodeId: 'home' } as never);
    await flush();
    await flush();

    // The track is taken down before the tap.
    gone = true;
    native.emit('onPlayRequest', {
      requestId: 'play-2',
      nodeId: 'home',
      itemId: 'track:t1',
    } as never);
    await flush();
    await flush();

    const resolved = native.lastCall('resolvePlay');
    expect(resolved).toBeDefined();
    const result = resolved!.args[1] as { ok: boolean; message?: string };
    expect(result.ok).toBe(false);
    expect(result.message).toBe('This track is no longer available.');
    // The stale cached entry was never queued.
    expect(engine.calls.filter((c) => c.startsWith('setQueue'))).toHaveLength(0);
    controller.detach();
  });

  test('late engine registration picks up now-playing sync when already connected', async () => {
    const native = createFakeNative();
    native.isConnected = true;
    const engine = createFakeEngine();
    // getEngine returns null until the provider registers late.
    let registered: unknown = null;
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => (registered as never) ?? null },
      native as never,
    );
    controller.attach();
    await flush();
    await flush();

    // Engine registers after attach (cold start ordering).
    registered = engine;
    setActiveEngine(engine as never);
    await flush();

    // Now-playing sync is live: track changes reach native.
    await engine.setQueue([toQueueTrack(track('t9'))], 0);
    await flush();
    expect(native.lastCall('updatePlayingItem')?.args).toEqual(['track:t9']);

    setActiveEngine(null);
    controller.detach();
  });

  test('shuffle/repeat commands refresh tabs so mode subtitles stay current', async () => {
    const native = createFakeNative();
    const engine = createFakeEngine();
    const controller = new CarPlayController(
      { api: createApi(), getEngine: () => engine as never },
      native as never,
    );
    controller.attach();
    native.emit('onCarPlayConnect', undefined as never);
    await flush();
    await flush();

    const tabsBefore = native.calls.filter((c) => c.name === 'setTabs').length;
    native.emit('onCommand', { command: 'shuffle' } as never);
    await flush();
    await flush();
    const tabsAfter = native.calls.filter((c) => c.name === 'setTabs').length;
    expect(tabsAfter).toBeGreaterThan(tabsBefore);
    controller.detach();
  });
});
