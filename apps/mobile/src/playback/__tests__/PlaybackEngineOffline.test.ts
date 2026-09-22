// Phase 25 — PlaybackEngine offline playback through the SHARED engine.
// The engine consults the offline source before minting a streaming
// session; a hit plays the local file with no session and no network,
// events go to the persisted offline queue, and everything else
// (queue, transport, heartbeats, now-playing) behaves identically.

import { ApiClient } from '../../api/client';
import type { PlaybackEngineOptions } from '../PlaybackEngine';
import { PlaybackEngine } from '../PlaybackEngine';
import { toQueueTrack } from '../types';
import type { TrackSummary } from '../../api/types';
import { FakeAudioDriver } from './fakeDriver';

function fakeResponse(status: number, data: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}

function createTestApi() {
  const sessions: { id: string; trackId: string }[] = [];
  const events: { sessionId: string; type: string }[] = [];
  let sessionSeq = 0;
  const fetchFn = async (url: string, init?: { method?: string; body?: string }) => {
    const body = (init?.body ? JSON.parse(init.body) : {}) as { trackId?: string; type?: string };
    if (url.endsWith('/v1/playback/sessions') && init?.method === 'POST') {
      sessionSeq += 1;
      const id = `sess-${sessionSeq}`;
      sessions.push({ id, trackId: body.trackId ?? '' });
      return fakeResponse(200, {
        id,
        token: 'test-token',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        hlsUrl: `/v1/playback/hls/master.m3u8?token=tok-${sessionSeq}`,
      });
    }
    const match = url.match(/\/v1\/playback\/sessions\/([^/]+)\/events$/);
    if (match && init?.method === 'POST') {
      events.push({ sessionId: match[1], type: body.type ?? '' });
      return fakeResponse(201, { id: `evt-${events.length}` });
    }
    throw new Error(`unexpected request: ${init?.method} ${url}`);
  };
  const api = new ApiClient({
    baseUrl: 'https://api.example.test/',
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { api, sessions, events };
}

const summary = (trackId: string): TrackSummary =>
  ({
    id: trackId,
    title: `Title ${trackId}`,
    artistName: 'Artist',
    albumTitle: null,
    durationMs: 180000,
  }) as unknown as TrackSummary;

const flush = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

const engines: PlaybackEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.destroy();
  }
  jest.useRealTimers();
});

interface OfflineHarness {
  engine: PlaybackEngine;
  driver: FakeAudioDriver;
  sessions: { id: string; trackId: string }[];
  events: { sessionId: string; type: string }[];
  queuedOfflineEvents: {
    offlineAuthorizationId: string;
    offlineSessionKey: string;
    type: string;
    positionMs: number;
  }[];
  resolveTrack: jest.Mock;
}

function createOfflineEngine(offlineTracks: Set<string>): OfflineHarness {
  const { api, sessions, events } = createTestApi();
  const driver = new FakeAudioDriver();
  const queuedOfflineEvents: OfflineHarness['queuedOfflineEvents'] = [];
  const resolveTrack = jest.fn(async (trackId: string) => {
    if (!offlineTracks.has(trackId)) return null;
    return {
      uri: `file:///docs/offline/tracks/${trackId}/audio.ts`,
      authorizationId: `authz-${trackId}`,
      audioVersion: 1,
    };
  });
  const engine = new PlaybackEngine({
    api,
    baseUrl: 'https://api.example.test/',
    driver,
    heartbeatIntervalMs: 60_000,
    offline: {
      resolveTrack,
      enqueueEvent: (event) => {
        queuedOfflineEvents.push(event);
      },
    },
  } satisfies PlaybackEngineOptions);
  engines.push(engine);
  return { engine, driver, sessions, events, queuedOfflineEvents, resolveTrack };
}

describe('PlaybackEngine offline playback', () => {
  it('plays a downloaded track with no streaming session and no network', async () => {
    const h = createOfflineEngine(new Set(['t1']));
    await h.engine.setQueue([toQueueTrack(summary('t1'))], 0);
    await flush();

    // The single shared driver loaded the LOCAL file URI.
    expect(h.driver.loadCalls).toHaveLength(1);
    expect(h.driver.loadCalls[0]).toBe('file:///docs/offline/tracks/t1/audio.ts');
    // No playback session was minted and no events hit the streaming endpoint.
    expect(h.sessions).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    // The snapshot reports offline playback.
    expect(h.engine.getSnapshot().isOfflinePlayback).toBe(true);
    expect(h.engine.getSnapshot().track?.trackId).toBe('t1');
  });

  it('routes offline START through the persisted event queue with the authorization id', async () => {
    const h = createOfflineEngine(new Set(['t1']));
    await h.engine.setQueue([toQueueTrack(summary('t1'))], 0);
    await flush();
    // Simulate the native driver reporting that playback began.
    h.driver.emit({ playing: true, currentTimeSec: 0, durationSec: 180 });
    await flush();

    const starts = h.queuedOfflineEvents.filter((e) => e.type === 'START');
    expect(starts).toHaveLength(1);
    expect(starts[0].offlineAuthorizationId).toBe('authz-t1');
    expect(starts[0].offlineSessionKey).toMatch(/^off-/);
    expect(starts[0].positionMs).toBe(0);
  });

  it('falls back to a streaming session when the track is not downloaded', async () => {
    const h = createOfflineEngine(new Set(['t1']));
    await h.engine.setQueue([toQueueTrack(summary('nope'))], 0);
    await flush();

    expect(h.resolveTrack).toHaveBeenCalledWith('nope');
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].trackId).toBe('nope');
    expect(h.driver.loadCalls[0]).toContain('/v1/playback/hls/master.m3u8');
    expect(h.engine.getSnapshot().isOfflinePlayback).toBe(false);
    expect(h.queuedOfflineEvents).toHaveLength(0);
    expect(h.events.filter((e) => e.type === 'START')).toHaveLength(1);
  });

  it('treats a resolveTrack failure as a miss (fail closed to streaming)', async () => {
    const h = createOfflineEngine(new Set(['t1']));
    h.resolveTrack.mockRejectedValueOnce(new Error('secure store exploded'));
    await h.engine.setQueue([toQueueTrack(summary('t1'))], 0);
    await flush();

    expect(h.sessions).toHaveLength(1);
    expect(h.engine.getSnapshot().isOfflinePlayback).toBe(false);
  });

  it('keeps queue semantics across offline and online tracks in one queue', async () => {
    const h = createOfflineEngine(new Set(['t1']));
    await h.engine.setQueue([toQueueTrack(summary('t1')), toQueueTrack(summary('t2'))], 0);
    await flush();
    expect(h.engine.getSnapshot().isOfflinePlayback).toBe(true);

    await h.engine.next();
    await flush();
    expect(h.engine.getSnapshot().isOfflinePlayback).toBe(false);
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].trackId).toBe('t2');
  });

  it('is offline by default when hooks are omitted (previous engine behavior)', async () => {
    const { api } = createTestApi();
    const driver = new FakeAudioDriver();
    const engine = new PlaybackEngine({
      api,
      baseUrl: 'https://api.example.test/',
      driver,
      heartbeatIntervalMs: 60_000,
    });
    engines.push(engine);
    await engine.setQueue([toQueueTrack(summary('t1'))], 0);
    await flush();
    expect(engine.getSnapshot().isOfflinePlayback).toBe(false);
    expect(driver.loadCalls[0]).toContain('/v1/playback/hls/master.m3u8');
  });
});
