// Phase 28 — forceOnline: room mode forces the SHARED engine to skip the
// Phase 25 offline source and mint an ordinary streaming session for every
// listener, even when the track is downloaded locally. Personal offline
// playback outside rooms is unchanged.

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

function createForceOnlineHarness() {
  const sessions: { id: string; trackId: string }[] = [];
  let sessionSeq = 0;
  const fetchFn = async (url: string, init?: { method?: string; body?: string }) => {
    const body = (init?.body ? JSON.parse(init.body) : {}) as { trackId?: string };
    if (url.endsWith('/v1/playback/sessions') && init?.method === 'POST') {
      sessionSeq += 1;
      const id = `sess-${sessionSeq}`;
      sessions.push({ id, trackId: body.trackId ?? '' });
      return fakeResponse(200, {
        id,
        token: 'redacted-test-token',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        hlsUrl: `/v1/playback/hls/master.m3u8?token=tok-${sessionSeq}`,
      });
    }
    throw new Error(`unexpected request: ${init?.method} ${url}`);
  };
  const api = new ApiClient({
    baseUrl: 'https://api.example.test/',
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  const driver = new FakeAudioDriver();
  const resolveTrack = jest.fn(async (trackId: string) => ({
    uri: `file:///docs/offline/tracks/${trackId}/audio.ts`,
    authorizationId: `authz-${trackId}`,
    audioVersion: 1,
  }));
  const engine = new PlaybackEngine({
    api,
    baseUrl: 'https://api.example.test/',
    driver,
    heartbeatIntervalMs: 60_000,
    offline: {
      resolveTrack,
      enqueueEvent: () => undefined,
    },
  } satisfies PlaybackEngineOptions);
  engines.push(engine);
  return { engine, driver, sessions, resolveTrack };
}

const summary = (trackId: string): TrackSummary =>
  ({
    id: trackId,
    title: `Title ${trackId}`,
    artistName: 'Artist',
    albumTitle: null,
    durationMs: 180000,
  }) as unknown as TrackSummary;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const engines: PlaybackEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.destroy();
  }
});

describe('PlaybackEngine forceOnline (Phase 28 room mode)', () => {
  it('mints a streaming session even when the track is downloaded', async () => {
    const h = createForceOnlineHarness();
    h.engine.setForceOnline(true);
    await h.engine.setQueue([toQueueTrack(summary('t1'))], 0);
    await flush();

    // The offline source was never consulted.
    expect(h.resolveTrack).not.toHaveBeenCalled();
    // An ordinary streaming session was minted and the driver loaded HLS.
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0].trackId).toBe('t1');
    expect(h.driver.loadCalls[0]).toContain('/v1/playback/hls/master.m3u8');
    expect(h.engine.getSnapshot().isOfflinePlayback).toBe(false);
    // destroyed in afterEach
  });

  it('restores offline-first playback after leaving room mode', async () => {
    const h = createForceOnlineHarness();
    h.engine.setForceOnline(true);
    h.engine.setForceOnline(false);
    await h.engine.setQueue([toQueueTrack(summary('t1'))], 0);
    await flush();

    expect(h.resolveTrack).toHaveBeenCalledWith('t1');
    expect(h.sessions).toHaveLength(0);
    expect(h.driver.loadCalls[0]).toBe('file:///docs/offline/tracks/t1/audio.ts');
    expect(h.engine.getSnapshot().isOfflinePlayback).toBe(true);
    // destroyed in afterEach
  });

  it('defaults to offline-first personal playback (unchanged Phase 25 behavior)', async () => {
    const h = createForceOnlineHarness();
    await h.engine.setQueue([toQueueTrack(summary('t1'))], 0);
    await flush();

    expect(h.resolveTrack).toHaveBeenCalledWith('t1');
    expect(h.sessions).toHaveLength(0);
    expect(h.engine.getSnapshot().isOfflinePlayback).toBe(true);
    // destroyed in afterEach
  });
});
