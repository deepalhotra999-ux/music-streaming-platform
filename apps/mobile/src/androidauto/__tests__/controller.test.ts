// Phase 24 — AndroidAutoController unit tests.
//
// The native module is injected as a deterministic fake (same event names
// and function surface as the Kotlin module). The engine is a minimal fake
// implementing the controller's slice of PlaybackEngine; the catalog is a
// real ApiClient over stubbed fetch. Pins:
//  - attach announces auth and pushes an initial snapshot; detach signs out,
//  - browse answers resolveChildren with content or a safe failure,
//  - item lookup answers from the advertised registry,
//  - play queues the node's refreshed tracks at the tapped index and
//    resolves ok; missing/takedown tracks fail safe,
//  - locked (subscription-required) snapshots resolve with the
//    subscription message, never as a generic error,
//  - transport/seek/mode commands reach the engine (never a second player),
//  - repeat ints map to engine modes,
//  - engine snapshots drive updatePlaybackState/updateQueue/
//    updateRepeatShuffle with queue dedupe,
//  - voice search fans out through searchCatalog and caches queue context.

import { ApiClient } from '../../api/client';
import type { TrackSummary } from '../../api/types';
import type { EngineSnapshot, QueueTrack, RepeatMode } from '../../playback/types';
import type {
  AutoChildrenRequestEvent,
  AutoCommandEvent,
  AutoItemRequestEvent,
  AutoLibraryRootRequestEvent,
  AutoPlayRequestEvent,
  AutoSearchRequestEvent,
} from 'waveform-android-auto';
import { AndroidAutoController } from '../controller';
import { PlaybackEngine } from '../../playback/PlaybackEngine';
import { FakeAudioDriver } from '../../playback/__tests__/fakeDriver';

// -- stub transport ----------------------------------------------------------

function ok(data: unknown) {
  return { status: 200, ok: true, json: async () => data };
}

function page<T>(data: T[]) {
  return ok({ data, pagination: { page: 1, limit: 50, total: data.length, totalPages: 1 } });
}

function track(id: string, status = 'READY'): TrackSummary {
  return {
    id,
    title: `Track ${id}`,
    durationMs: 180000,
    status,
    artistId: 'artist1',
    artistName: 'Artist One',
    albumId: 'album1',
    albumTitle: 'Album One',
  };
}

type RouteHandler = (url: string) => { status: number; ok: boolean; json: () => Promise<unknown> };

function createApi(handler: RouteHandler): ApiClient {
  return new ApiClient({
    baseUrl: 'http://test.local',
    fetchFn: (async (url: string) => handler(url)) as typeof fetch,
  });
}

// -- fake native module ------------------------------------------------------

interface ListenerMap {
  onLibraryRootRequest: Array<(e: AutoLibraryRootRequestEvent) => void>;
  onChildrenRequest: Array<(e: AutoChildrenRequestEvent) => void>;
  onItemRequest: Array<(e: AutoItemRequestEvent) => void>;
  onPlayRequest: Array<(e: AutoPlayRequestEvent) => void>;
  onCommand: Array<(e: AutoCommandEvent) => void>;
  onSearchRequest: Array<(e: AutoSearchRequestEvent) => void>;
}

interface EventPayloads {
  onLibraryRootRequest: AutoLibraryRootRequestEvent;
  onChildrenRequest: AutoChildrenRequestEvent;
  onItemRequest: AutoItemRequestEvent;
  onPlayRequest: AutoPlayRequestEvent;
  onCommand: AutoCommandEvent;
  onSearchRequest: AutoSearchRequestEvent;
}

function createFakeNative() {
  const listeners: ListenerMap = {
    onLibraryRootRequest: [],
    onChildrenRequest: [],
    onItemRequest: [],
    onPlayRequest: [],
    onCommand: [],
    onSearchRequest: [],
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
    notifyAuthState: (signedIn: boolean) => record('notifyAuthState', signedIn),
    resolveLibraryRoot: (requestId: string, rootId: string) =>
      record('resolveLibraryRoot', requestId, rootId),
    resolveChildren: (requestId: string, result: unknown) =>
      record('resolveChildren', requestId, result),
    resolveItem: (requestId: string, item: unknown) => record('resolveItem', requestId, item),
    resolvePlay: (requestId: string, result: unknown) => record('resolvePlay', requestId, result),
    resolveSearch: (requestId: string, items: unknown) => record('resolveSearch', requestId, items),
    updatePlaybackState: (state: unknown) => record('updatePlaybackState', state),
    updateQueue: (items: unknown, activeIndex: number) => record('updateQueue', items, activeIndex),
    updateRepeatShuffle: (repeatMode: string, shuffle: boolean) =>
      record('updateRepeatShuffle', repeatMode, shuffle),
    addListener: (event: keyof ListenerMap, handler: (...args: never[]) => void) => {
      (listeners[event] as Array<(...args: never[]) => void>).push(handler);
      return {
        remove: () => {
          removed.push(handler as () => void);
        },
      };
    },
    emit<K extends keyof EventPayloads>(event: K, payload: EventPayloads[K]) {
      for (const handler of listeners[event]) {
        (handler as (p: unknown) => void)(payload);
      }
    },
    lastCall: (name: string) => [...calls].reverse().find((c) => c.name === name),
    callCount: (name: string) => calls.filter((c) => c.name === name).length,
  };
  return fake;
}

// -- fake engine -------------------------------------------------------------

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
    isOfflinePlayback: false,
    canNext: false,
    canPrevious: false,
    repeatMode: 'off',
    shuffle: false,
  };
}

function toQT(t: TrackSummary): QueueTrack {
  return {
    trackId: t.id,
    title: t.title,
    artistName: t.artistName,
    albumTitle: t.albumTitle,
    albumId: t.albumId,
    artworkUrl: null,
    durationMs: t.durationMs,
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
    stop: () => calls.push('stop'),
    next: () => calls.push('next'),
    previous: () => calls.push('previous'),
    playAt: (index: number) => {
      calls.push(`playAt:${index}`);
      engine.setSnapshot({ trackIndex: index, track: snapshot.queue[index] ?? null });
    },
    seekTo: async (ms: number) => {
      calls.push(`seekTo:${ms}`);
      engine.setSnapshot({ positionMs: ms });
    },
    setShuffle: (v: boolean) => {
      calls.push(`setShuffle:${v}`);
      engine.setSnapshot({ shuffle: v });
    },
    setRepeatMode: (m: RepeatMode) => {
      calls.push(`setRepeatMode:${m}`);
      engine.setSnapshot({ repeatMode: m });
    },
    setQueue: async (tracks: QueueTrack[], startIndex = 0) => {
      calls.push(`setQueue:${tracks.length}:${startIndex}`);
      engine.setSnapshot({
        queue: tracks,
        trackIndex: startIndex,
        track: tracks[startIndex] ?? null,
        state: 'playing',
      });
    },
  };
  return engine;
}

// -- helpers -----------------------------------------------------------------

const HISTORY: RouteHandler = (url) =>
  url.includes('/v1/me/history')
    ? page([{ track: track('t1') }, { track: track('t2') }])
    : page([]);

function setup(overrides: Partial<EngineSnapshot> = {}, handler: RouteHandler = HISTORY) {
  const native = createFakeNative();
  const engine = createFakeEngine(overrides);
  const controller = new AndroidAutoController(
    { api: createApi(handler), getEngine: () => engine as never },
    native as never,
  );
  return { native, engine, controller };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// -- tests -------------------------------------------------------------------

describe('AndroidAutoController', () => {
  test('attach announces auth and pushes an initial snapshot; detach signs out', () => {
    const { native, controller } = setup();
    controller.attach();
    expect(native.lastCall('notifyAuthState')?.args).toEqual([true]);
    expect(native.callCount('updatePlaybackState')).toBe(1);
    expect(native.callCount('updateQueue')).toBe(1);
    expect(native.callCount('updateRepeatShuffle')).toBe(1);
    controller.detach();
    expect(native.lastCall('notifyAuthState')?.args).toEqual([false]);
    expect(native.removedCount()).toBe(6);
  });

  test('attach is a no-op without a native module', () => {
    const engine = createFakeEngine();
    const controller = new AndroidAutoController(
      { api: createApi(HISTORY), getEngine: () => engine as never },
      null,
    );
    expect(() => controller.attach()).not.toThrow();
    expect(() => controller.detach()).not.toThrow();
  });

  test('library root resolves to waveform:root', () => {
    const { native, controller } = setup();
    controller.attach();
    native.emit('onLibraryRootRequest', { requestId: 'r1' });
    expect(native.lastCall('resolveLibraryRoot')?.args).toEqual(['r1', 'waveform:root']);
    controller.detach();
  });

  test('children resolve with content; failures resolve safe', async () => {
    const { native, controller } = setup();
    controller.attach();
    native.emit('onChildrenRequest', {
      requestId: 'c1',
      parentId: 'waveform:root',
      page: 0,
      pageSize: 50,
    });
    await tick();
    const good = native.lastCall('resolveChildren')?.args as unknown[];
    expect(good[0]).toBe('c1');
    expect((good[1] as { ok: boolean }).ok).toBe(true);
    expect((good[1] as { items: unknown[] }).items).toHaveLength(6);

    const failingNative = createFakeNative();
    const failing = new AndroidAutoController(
      {
        api: createApi(() => {
          throw new Error('boom');
        }),
        getEngine: () => createFakeEngine() as never,
      },
      failingNative as never,
    );
    failing.attach();
    failingNative.emit('onChildrenRequest', {
      requestId: 'c2',
      parentId: 'waveform:recent',
      page: 0,
      pageSize: 50,
    });
    await tick();
    const bad = failingNative.lastCall('resolveChildren')?.args as unknown[];
    expect(bad[0]).toBe('c2');
    expect((bad[1] as { ok: boolean }).ok).toBe(false);
    controller.detach();
    failing.detach();
  });

  test('item lookup answers from the advertised registry', async () => {
    const { native, controller } = setup();
    controller.attach();
    native.emit('onChildrenRequest', {
      requestId: 'c1',
      parentId: 'waveform:recent',
      page: 0,
      pageSize: 50,
    });
    await tick();
    native.emit('onItemRequest', { requestId: 'i1', mediaId: 'waveform:track:t1' });
    const found = native.lastCall('resolveItem')?.args as unknown[];
    expect(found[0]).toBe('i1');
    expect((found[1] as { mediaId: string }).mediaId).toBe('waveform:track:t1');
    native.emit('onItemRequest', { requestId: 'i2', mediaId: 'waveform:track:never-seen' });
    const missing = native.lastCall('resolveItem')?.args as unknown[];
    expect(missing[1]).toBeNull();
    controller.detach();
  });

  test('play taps queue the refreshed node at the tapped index', async () => {
    const { native, engine, controller } = setup();
    controller.attach();
    native.emit('onChildrenRequest', {
      requestId: 'c1',
      parentId: 'waveform:recent',
      page: 0,
      pageSize: 50,
    });
    await tick();
    native.emit('onPlayRequest', { requestId: 'p1', mediaId: 'waveform:track:t2' });
    await tick();
    expect(engine.calls).toContain('setQueue:2:1');
    const resolved = native.lastCall('resolvePlay')?.args as unknown[];
    expect(resolved).toEqual(['p1', { ok: true }]);
    // The new queue is projected to native immediately.
    const queueCall = native.lastCall('updateQueue')?.args as unknown[];
    expect((queueCall[0] as { mediaId: string }[]).map((i) => i.mediaId)).toEqual([
      'waveform:track:t1',
      'waveform:track:t2',
    ]);
    expect(queueCall[1]).toBe(1);
    controller.detach();
  });

  test('play of an offline-downloaded track uses the shared engine offline path', async () => {
    // Boundary: Android Auto drives the ONE PlaybackEngine; the engine's
    // offline resolver (not the controller) decides local vs streaming. A
    // downloaded track must play from its local file with no session.
    const native = createFakeNative();
    const driver = new FakeAudioDriver();
    const sessionPosts: string[] = [];
    const engineApi = new ApiClient({
      baseUrl: 'http://test.local',
      fetchFn: (async (url: string, init?: { method?: string }) => {
        if (url.includes('/v1/playback/sessions') && init?.method === 'POST') {
          sessionPosts.push(url);
          return {
            status: 200,
            ok: true,
            json: async () => ({
              id: 'sess-online',
              token: 'tok',
              expiresAt: new Date(Date.now() + 900_000).toISOString(),
              hlsUrl: '/v1/playback/hls/master.m3u8?token=tok',
            }),
          };
        }
        throw new Error(`unexpected request: ${init?.method} ${url}`);
      }) as typeof fetch,
    });
    const engine = new PlaybackEngine({
      api: engineApi,
      baseUrl: 'http://test.local',
      driver,
      offline: {
        resolveTrack: async (trackId: string) =>
          trackId === 't2'
            ? {
                uri: 'file:///docs/offline/tracks/t2/audio.ts',
                authorizationId: 'authz-t2',
                audioVersion: 1,
              }
            : null,
        enqueueEvent: () => undefined,
      },
    });
    await engine.initialize();
    const controller = new AndroidAutoController(
      { api: createApi(HISTORY), getEngine: () => engine },
      native as never,
    );
    controller.attach();
    native.emit('onChildrenRequest', {
      requestId: 'c1',
      parentId: 'waveform:recent',
      page: 0,
      pageSize: 50,
    });
    await tick();
    native.emit('onPlayRequest', { requestId: 'p1', mediaId: 'waveform:track:t2' });
    await tick();
    await tick();

    const resolved = native.lastCall('resolvePlay')?.args as unknown[];
    expect(resolved).toEqual(['p1', { ok: true }]);
    const snapshot = engine.getSnapshot();
    expect(snapshot.track?.trackId).toBe('t2');
    expect(snapshot.isOfflinePlayback).toBe(true);
    // The local file was used: no streaming session minted, driver loaded
    // the offline URI, and there is still exactly one player.
    expect(sessionPosts).toHaveLength(0);
    expect(driver.loadCalls).toEqual(['file:///docs/offline/tracks/t2/audio.ts']);
    expect(driver.maxConcurrentPlayers).toBe(1);
    engine.destroy();
    controller.detach();
  });

  test('play of an unadvertised track fails safe', async () => {
    const { native, engine, controller } = setup();
    controller.attach();
    native.emit('onPlayRequest', { requestId: 'p1', mediaId: 'waveform:track:ghost' });
    await tick();
    expect(engine.calls).not.toContainEqual(expect.stringMatching(/^setQueue/));
    const resolved = native.lastCall('resolvePlay')?.args as unknown[];
    expect((resolved[1] as { ok: boolean }).ok).toBe(false);
    controller.detach();
  });

  test('play surfaces setQueue rejections instead of hanging', async () => {
    const { native, controller } = setup();
    const engine = createFakeEngine();
    (engine as { setQueue: unknown }).setQueue = async () => {
      throw new Error('network down');
    };
    const failing = new AndroidAutoController(
      { api: createApi(HISTORY), getEngine: () => engine as never },
      native as never,
    );
    failing.attach();
    native.emit('onChildrenRequest', {
      requestId: 'c1',
      parentId: 'waveform:recent',
      page: 0,
      pageSize: 50,
    });
    await tick();
    native.emit('onPlayRequest', { requestId: 'p1', mediaId: 'waveform:track:t1' });
    await tick();
    const resolved = native.lastCall('resolvePlay')?.args as unknown[];
    expect((resolved[1] as { ok: boolean; message: string }).ok).toBe(false);
    expect((resolved[1] as { message: string }).message).toMatch(/connection/i);
    controller.detach();
    failing.detach();
  });

  test('play with a locked snapshot reports the subscription message', async () => {
    const { native, controller } = setup({ locked: true });
    controller.attach();
    native.emit('onChildrenRequest', {
      requestId: 'c1',
      parentId: 'waveform:recent',
      page: 0,
      pageSize: 50,
    });
    await tick();
    native.emit('onPlayRequest', { requestId: 'p1', mediaId: 'waveform:track:t1' });
    await tick();
    const resolved = native.lastCall('resolvePlay')?.args as unknown[];
    expect((resolved[1] as { ok: boolean; title: string }).ok).toBe(false);
    expect((resolved[1] as { title: string }).title).toMatch(/subscription/i);
    controller.detach();
  });

  test('commands reach the engine; repeat ints map to modes', () => {
    const { native, engine, controller } = setup();
    controller.attach();
    const cmd = (command: AutoCommandEvent['command'], extra: Partial<AutoCommandEvent> = {}) =>
      native.emit('onCommand', { command, ...extra } as AutoCommandEvent);

    cmd('play');
    cmd('pause');
    cmd('next');
    cmd('previous');
    cmd('stop');
    cmd('seek', { positionMs: 45000 });
    cmd('restart');
    cmd('set-item', { index: 0, positionMs: 1000 });
    cmd('shuffle', { shuffle: true });
    cmd('repeat', { repeatMode: 2 });
    cmd('repeat', { repeatMode: 1 });
    cmd('repeat', {});

    expect(engine.calls).toEqual(
      expect.arrayContaining([
        'play',
        'pause',
        'next',
        'previous',
        'stop',
        'seekTo:45000',
        'seekTo:0',
        'setShuffle:true',
        'setRepeatMode:all',
        'setRepeatMode:one',
        'setRepeatMode:off',
      ]),
    );
    controller.detach();
  });

  test('snapshot changes drive native projection with queue dedupe', () => {
    const { native, engine, controller } = setup();
    controller.attach();
    const queueCalls = native.callCount('updateQueue');

    engine.setSnapshot({ state: 'playing', positionMs: 1000 });
    expect(native.callCount('updateQueue')).toBe(queueCalls); // queue unchanged → no push
    expect(native.callCount('updatePlaybackState')).toBeGreaterThan(1);

    const tracks = [toQT(track('t1')), toQT(track('t2'))];
    engine.setSnapshot({ queue: tracks, trackIndex: 0, track: tracks[0] });
    expect(native.callCount('updateQueue')).toBe(queueCalls + 1);
    const last = native.lastCall('updateQueue')?.args as unknown[];
    expect((last[0] as { mediaId: string }[])[0].mediaId).toBe('waveform:track:t1');
    expect(last[1]).toBe(0);

    engine.setShuffle(true);
    expect(native.lastCall('updateRepeatShuffle')?.args).toEqual(['off', true]);
    controller.detach();
  });

  test('voice search resolves categorized results and caches context', async () => {
    const handler: RouteHandler = (url) => {
      if (url.includes('/v1/tracks')) return page([track('t1'), track('t9', 'TAKEDOWN')]);
      if (url.includes('/v1/albums')) {
        return page([{ id: 'a1', title: 'A', artistName: 'X' }]);
      }
      if (url.includes('/v1/artists')) return page([{ id: 'ar1', name: 'Ar' }]);
      if (url.includes('/v1/playlists/public')) {
        return page([{ id: 'p1', title: 'P', trackCount: 2 }]);
      }
      return page([]);
    };
    const { native, controller } = setup({}, handler);
    controller.attach();
    native.emit('onSearchRequest', { requestId: 's1', query: 'hello' });
    await tick();
    const resolved = native.lastCall('resolveSearch')?.args as unknown[];
    expect(resolved[0]).toBe('s1');
    const items = resolved[1] as { mediaId: string; playable: boolean; browsable: boolean }[];
    expect(items.map((i) => i.mediaId)).toEqual([
      'waveform:track:t1',
      'waveform:album:a1',
      'waveform:artist:ar1',
      'waveform:playlist:p1',
    ]);
    expect(items[0].playable).toBe(true);
    expect(items[1].browsable).toBe(true);
    // Search results are registered, so a later onGetItem for the track
    // answers from the advertised registry.
    native.emit('onItemRequest', { requestId: 'i9', mediaId: 'waveform:track:t1' });
    await tick();
    const found = native.lastCall('resolveItem')?.args as unknown[];
    expect(found[0]).toBe('i9');
    expect((found[1] as { mediaId: string }).mediaId).toBe('waveform:track:t1');
    controller.detach();
  });

  test('empty search query resolves empty; failures resolve empty', async () => {
    const { native, controller } = setup();
    controller.attach();
    native.emit('onSearchRequest', { requestId: 's1', query: '   ' });
    await tick();
    expect(native.lastCall('resolveSearch')?.args).toEqual(['s1', []]);

    const failingNative = createFakeNative();
    const failing = new AndroidAutoController(
      {
        api: createApi(() => {
          throw new Error('boom');
        }),
        getEngine: () => createFakeEngine() as never,
      },
      failingNative as never,
    );
    failing.attach();
    failingNative.emit('onSearchRequest', { requestId: 's2', query: 'hello' });
    await tick();
    expect(failingNative.lastCall('resolveSearch')?.args).toEqual(['s2', []]);
    controller.detach();
    failing.detach();
  });
});
