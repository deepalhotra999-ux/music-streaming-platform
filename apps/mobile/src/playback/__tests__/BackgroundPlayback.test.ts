// Phase 10 — background playback: engine-side behavior testable without hardware.
//
// Covers what the engine owns: now-playing (lock screen / notification)
// registration across the track lifecycle, and state/telemetry behavior when
// the OS pauses or resumes the native player underneath the engine —
// interruption began/ended (phone call), headphone unplug (route change),
// remote pause/play, and audio-focus loss/gain. The native module performs
// the actual pause/resume; here the fake driver replays its observable
// effect (a playing:false / playing:true status update).

import { ApiClient } from '../../api/client';
import type { PlaybackEngineOptions } from '../PlaybackEngine';
import { PlaybackEngine } from '../PlaybackEngine';
import type { NowPlayingMetadata, QueueTrack } from '../types';
import { FakeAudioDriver } from './fakeDriver';

// -- fakes (mirrors PlaybackEngine.test.ts harness) --------------------------

function fakeResponse(status: number, data: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}

function createTestApi() {
  const sessions: { id: string; trackId: string }[] = [];
  const events: { sessionId: string; type: string; positionMs?: number }[] = [];
  let sessionSeq = 0;

  const fetchFn = async (url: string, init?: { method?: string; body?: string }) => {
    const body = (init?.body ? JSON.parse(init.body) : {}) as {
      trackId?: string;
      type?: string;
      positionMs?: number;
    };
    if (url.endsWith('/v1/playback/sessions') && init?.method === 'POST') {
      sessionSeq += 1;
      const id = `sess-${sessionSeq}`;
      sessions.push({ id, trackId: body.trackId ?? '' });
      return fakeResponse(200, {
        id,
        token: `tok-${sessionSeq}`,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        hlsUrl: `/v1/playback/hls/master.m3u8?token=tok-${sessionSeq}`,
      });
    }
    const match = url.match(/\/v1\/playback\/sessions\/([^/]+)\/events$/);
    if (match && init?.method === 'POST') {
      events.push({ sessionId: match[1], type: body.type ?? '', positionMs: body.positionMs });
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

const track = (
  trackId: string,
  title = `Title ${trackId}`,
  extra: Partial<QueueTrack> = {},
): QueueTrack => ({
  trackId,
  title,
  artistName: 'Artist',
  ...extra,
});

const flush = async (rounds = 30) => {
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

function createEngine(
  api: ApiClient,
  opts: Partial<PlaybackEngineOptions> & { driver?: FakeAudioDriver } = {},
) {
  const driver = opts.driver ?? new FakeAudioDriver();
  const engine = new PlaybackEngine({
    api,
    baseUrl: 'https://api.example.test/',
    driver,
    heartbeatIntervalMs: 60_000,
    ...opts,
  });
  engines.push(engine);
  return { engine, driver };
}

/** Load one track and bring it to 'playing'. */
async function playTrack(
  engine: PlaybackEngine,
  driver: FakeAudioDriver,
  tracks: QueueTrack[],
  index = 0,
  durationSec = 30,
) {
  await engine.setQueue(tracks, index);
  driver.emit({ playing: true, currentTimeSec: 0, durationSec });
  await flush();
}

// -- tests -------------------------------------------------------------------

describe('Phase 10 — now-playing registration', () => {
  it('publishes now-playing metadata when a track loads', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await engine.setQueue([
      track('t1', 'Song One', { albumTitle: 'Album One', artworkUrl: 'https://img.test/a.png' }),
    ]);

    const expected: NowPlayingMetadata = {
      title: 'Song One',
      artist: 'Artist',
      albumTitle: 'Album One',
      artworkUrl: 'https://img.test/a.png',
    };
    expect(driver.nowPlayingCalls).toEqual([expected]);
  });

  it('maps missing optional metadata to undefined for the driver contract', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await engine.setQueue([track('t1', 'Song One')]);

    expect(driver.nowPlayingCalls).toEqual([
      { title: 'Song One', artist: 'Artist', albumTitle: undefined, artworkUrl: undefined },
    ]);
  });

  it('replaces the registration on track change (clear, then new metadata)', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1', 'Song One'), track('t2', 'Song Two')]);
    driver.nowPlayingCalls = [];

    engine.next();
    await flush();

    // The old track is genuinely gone during the load gap, so the driver
    // sees a clear followed by the new track's registration — never two
    // live registrations, never a stale one.
    expect(driver.nowPlayingCalls).toEqual([
      null,
      { title: 'Song Two', artist: 'Artist', albumTitle: undefined, artworkUrl: undefined },
    ]);
    expect(engine.getSnapshot().track?.trackId).toBe('t2');
  });

  it('clears now-playing on stop', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);
    driver.nowPlayingCalls = [];

    engine.stop();

    expect(driver.nowPlayingCalls).toEqual([null]);
    expect(engine.getSnapshot().state).toBe('idle');
  });

  it('clears now-playing when the queue ends naturally', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);
    driver.nowPlayingCalls = [];

    driver.emit({ didJustFinish: true, playing: false, currentTimeSec: 30, durationSec: 30 });
    await flush();

    expect(engine.getSnapshot().state).toBe('ended');
    expect(driver.nowPlayingCalls).toEqual([null]);
  });

  it('clears now-playing on destroy', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);
    driver.nowPlayingCalls = [];

    engine.destroy();
    engines.pop(); // already destroyed; keep afterEach from double-destroying

    expect(driver.nowPlayingCalls).toEqual([null]);
  });

  it('does not touch now-playing when stopping an idle engine', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);

    engine.stop();

    expect(driver.nowPlayingCalls).toEqual([]);
  });
});

describe('Phase 10 — interruption behavior', () => {
  it('treats a native pause (call / headphone unplug / remote pause) like pause', async () => {
    jest.useFakeTimers();
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api, { heartbeatIntervalMs: 15_000 });
    await engine.setQueue([track('t1', 'Song One'), track('t2', 'Song Two')]);
    engine.setRepeatMode('all');
    engine.setShuffle(true);
    driver.emit({ playing: true, currentTimeSec: 10, durationSec: 30 });
    await flush();

    // The OS paused the native player out from under the engine.
    driver.emit({ playing: false, currentTimeSec: 10, durationSec: 30 });
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.state).toBe('paused');
    expect(snap.positionMs).toBe(10_000);
    // Queue, track, position, and modes survive the interruption untouched.
    expect(snap.queue.map((q) => q.trackId)).toEqual(['t1', 't2']);
    expect(snap.trackIndex).toBe(0);
    expect(snap.track?.title).toBe('Song One');
    expect(snap.repeatMode).toBe('all');
    expect(snap.shuffle).toBe(true);

    // The heartbeat cadence stops while the track is not audibly playing.
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(t.events.filter((e) => e.type === 'HEARTBEAT')).toHaveLength(0);
  });

  it('resumes state and telemetry when the OS hands playback back', async () => {
    jest.useFakeTimers();
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api, { heartbeatIntervalMs: 15_000 });
    await playTrack(engine, driver, [track('t1')]);
    driver.emit({ playing: true, currentTimeSec: 10, durationSec: 30 });
    await flush();

    // Interruption began (e.g. phone call).
    driver.emit({ playing: false, currentTimeSec: 10, durationSec: 30 });
    await flush();
    expect(engine.getSnapshot().state).toBe('paused');

    // Interruption ended with "should resume" (or audio focus regained):
    // the native player resumes on its own and the engine follows.
    driver.emit({ playing: true, currentTimeSec: 10, durationSec: 30 });
    await flush();
    expect(engine.getSnapshot().state).toBe('playing');

    jest.advanceTimersByTime(15_000);
    await flush();
    expect(t.events.filter((e) => e.type === 'HEARTBEAT')).toHaveLength(1);
  });

  it('engine controls keep working after a native pause', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1'), track('t2')]);

    // Remote pause from the lock screen.
    driver.emit({ playing: false, currentTimeSec: 5, durationSec: 30 });
    await flush();
    expect(engine.getSnapshot().state).toBe('paused');

    // The queue is intact: next() loads the following track and plays it.
    engine.next();
    await flush();
    const snap = engine.getSnapshot();
    expect(snap.track?.trackId).toBe('t2');
    expect(snap.state).toBe('playing');
    expect(t.sessions.map((s) => s.trackId)).toEqual(['t1', 't2']);
  });

  it('a native pause during buffering does not corrupt state', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await engine.setQueue([track('t1')]);
    driver.emit({ playing: true, isBuffering: true, currentTimeSec: 4, durationSec: 30 });
    await flush();
    expect(engine.getSnapshot().state).toBe('buffering');

    // Interruption while stalled: the player reports not-playing.
    driver.emit({ playing: false, isBuffering: false, currentTimeSec: 4, durationSec: 30 });
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.state).toBe('paused');
    expect(snap.positionMs).toBe(4_000);
    expect(snap.track?.trackId).toBe('t1');
  });
});
