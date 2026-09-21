// Phase 8 — PlaybackEngine unit tests.
//
// The engine is framework-free, so it runs here with a fake AudioDriver
// and a fake API transport (a real ApiClient over a stub fetch). These pin:
// session-per-track + relative HLS URL resolution, transport controls,
// queue semantics, START/HEARTBEAT/COMPLETE/ERROR reporting, single-player
// hygiene, stale-load races, and network-error recovery.

import { ApiClient } from '../../api/client';
import type { PlaybackEngineOptions } from '../PlaybackEngine';
import { PlaybackEngine } from '../PlaybackEngine';
import { toQueueTrack } from '../types';
import type { QueueTrack } from '../types';
import type { TrackSummary } from '../../api/types';
import { FakeAudioDriver } from './fakeDriver';

// -- fakes -----------------------------------------------------------------

function fakeResponse(status: number, data: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data,
  };
}

interface TestApiOptions {
  failSessionFor?: Set<string>;
  failEvents?: boolean;
  holdSessions?: boolean;
  onSession?: (trackId: string) => void;
}

/**
 * Real ApiClient over a stubbed fetch. Mirrors the real Phase 7 contract:
 * hlsUrl is a relative, session-scoped path with the token in the query.
 */
function createTestApi(options: TestApiOptions = {}) {
  const sessions: { id: string; trackId: string }[] = [];
  const events: { sessionId: string; type: string; positionMs?: number }[] = [];
  let sessionSeq = 0;
  const heldResolvers: (() => void)[] = [];

  const fetchFn = async (url: string, init?: { method?: string; body?: string }) => {
    const body = (init?.body ? JSON.parse(init.body) : {}) as {
      trackId?: string;
      type?: string;
      positionMs?: number;
    };
    if (url.endsWith('/v1/playback/sessions') && init?.method === 'POST') {
      const trackId = body.trackId ?? '';
      options.onSession?.(trackId);
      if (options.failSessionFor?.has(trackId)) {
        return fakeResponse(403, { title: 'Forbidden', detail: 'denied' });
      }
      if (options.holdSessions) {
        await new Promise<void>((resolve) => {
          heldResolvers.push(resolve);
        });
      }
      sessionSeq += 1;
      const id = `sess-${sessionSeq}`;
      sessions.push({ id, trackId });
      return fakeResponse(200, {
        id,
        token: `tok-${sessionSeq}`,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        hlsUrl: `/v1/playback/hls/master.m3u8?token=tok-${sessionSeq}`,
      });
    }
    const match = url.match(/\/v1\/playback\/sessions\/([^/]+)\/events$/);
    if (match && init?.method === 'POST') {
      if (options.failEvents) {
        return fakeResponse(500, { title: 'boom' });
      }
      events.push({ sessionId: match[1], type: body.type ?? '', positionMs: body.positionMs });
      return fakeResponse(201, { id: `evt-${events.length}` });
    }
    throw new Error(`unexpected request: ${init?.method} ${url}`);
  };

  const api = new ApiClient({
    baseUrl: 'https://api.example.test/',
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return {
    api,
    sessions,
    events,
    releaseSessions: () => {
      for (const resolve of heldResolvers.splice(0)) {
        resolve();
      }
    },
  };
}

const track = (trackId: string, title = `Title ${trackId}`): QueueTrack => ({
  trackId,
  title,
  artistName: 'Artist',
});

/** Drain pending microtasks (fire-and-forget event reporting). */
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

// -- tests -----------------------------------------------------------------

describe('PlaybackEngine', () => {
  it('creates one session per track and resolves the relative HLS URL against the base URL', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await engine.initialize();
    expect(driver.initializeCalls).toBe(1);

    await engine.setQueue([track('t1', 'Song One')]);

    expect(t.sessions).toEqual([{ id: 'sess-1', trackId: 't1' }]);
    expect(driver.loadCalls).toEqual([
      'https://api.example.test/v1/playback/hls/master.m3u8?token=tok-1',
    ]);
    expect(engine.getSnapshot().state).toBe('playing'); // setQueue autoplays
  });

  it('reports START once when playback begins, then mirrors position/duration/buffering', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1', 'Song One')]);

    // A duplicate playing status must not double-report START.
    driver.emit({ playing: true, currentTimeSec: 1, durationSec: 30 });
    await flush();

    expect(t.events.filter((e) => e.type === 'START')).toHaveLength(1);
    expect(t.events[0]).toEqual({ sessionId: 'sess-1', type: 'START', positionMs: 0 });

    const snap = engine.getSnapshot();
    expect(snap.state).toBe('playing');
    expect(snap.track?.title).toBe('Song One');
    expect(snap.positionMs).toBe(1000);
    expect(snap.durationMs).toBe(30000);
    expect(snap.isBuffering).toBe(false);
    expect(snap.canNext).toBe(false);
    expect(snap.canPrevious).toBe(false);
  });

  it('enters buffering state when the driver stalls', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await engine.setQueue([track('t1')]);
    driver.emit({ playing: true, isBuffering: true, currentTimeSec: 4, durationSec: 30 });
    await flush();

    let snap = engine.getSnapshot();
    expect(snap.state).toBe('buffering');
    expect(snap.isBuffering).toBe(true);

    driver.emit({ playing: true, isBuffering: false, currentTimeSec: 5, durationSec: 30 });
    snap = engine.getSnapshot();
    expect(snap.state).toBe('playing');
    expect(snap.isBuffering).toBe(false);
  });

  it('pause/toggle drive the driver and snapshot state', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);

    engine.pause();
    expect(driver.pauseCalls).toBe(1);
    expect(engine.getSnapshot().state).toBe('paused');

    engine.toggle();
    expect(driver.playCalls).toBe(2); // 1 from autoplay + 1 from toggle
    expect(engine.getSnapshot().state).toBe('playing');

    engine.toggle();
    expect(driver.pauseCalls).toBe(2);
    expect(engine.getSnapshot().state).toBe('paused');
  });

  it('seekTo clamps to the known duration', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);

    await engine.seekTo(10_000);
    expect(driver.seekCalls).toEqual([10000]);
    expect(engine.getSnapshot().positionMs).toBe(10000);

    await engine.seekTo(99_999);
    expect(driver.seekCalls).toEqual([10000, 30000]);
    expect(engine.getSnapshot().positionMs).toBe(30000);
  });

  it('applies a seek issued while loading once the player is ready', async () => {
    const t = createTestApi({ holdSessions: true });
    const { engine, driver } = createEngine(t.api);
    const pending = engine.setQueue([track('t1')]);
    await flush();
    expect(engine.getSnapshot().state).toBe('loading');

    await engine.seekTo(8000);
    expect(engine.getSnapshot().positionMs).toBe(8000);
    expect(driver.seekCalls).toHaveLength(0); // not loaded yet

    t.releaseSessions();
    await pending;
    await flush();

    // The initial loaded status (published synchronously during load)
    // applied the pending seek.
    expect(driver.seekCalls).toEqual([8000]);
  });

  it('next() destroys the old player before the new session: never two players, no COMPLETE on skip', async () => {
    const journal: string[] = [];
    const t = createTestApi({ onSession: (trackId) => journal.push(`session:${trackId}`) });
    const driver = new FakeAudioDriver((name) => journal.push(name));
    const { engine } = createEngine(t.api, { driver });

    await playTrack(engine, driver, [track('t1'), track('t2')]);
    engine.next();
    await flush();

    expect(journal).toEqual([
      'destroy', // teardown before the first session is even requested
      'session:t1',
      expect.stringMatching(/^load:https:\/\/api\.example\.test\/v1\/playback\/hls\/master\.m3u8\?token=tok-1$/),
      'destroy', // old player gone before the new session
      'session:t2',
      expect.stringMatching(/^load:https:\/\/api\.example\.test\/v1\/playback\/hls\/master\.m3u8\?token=tok-2$/),
    ]);
    expect(driver.maxConcurrentPlayers).toBeLessThanOrEqual(1);
    // A manual skip is not a completed play.
    expect(t.events.some((e) => e.sessionId === 'sess-1' && e.type === 'COMPLETE')).toBe(false);
    expect(engine.getSnapshot().track?.trackId).toBe('t2');
  });

  it('previous() restarts the track when past the first seconds', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1'), track('t2')], 1);
    driver.emit({ playing: true, currentTimeSec: 10, durationSec: 30 });

    engine.previous();
    await flush();

    expect(t.sessions).toHaveLength(1); // same session, no reload
    expect(driver.seekCalls).toEqual([0]);
    expect(engine.getSnapshot().track?.trackId).toBe('t2');
  });

  it('previous() goes back a track when near the start', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1'), track('t2')], 1);
    driver.emit({ playing: true, currentTimeSec: 2, durationSec: 30 });

    engine.previous();
    await flush();

    // The queue loaded t2 first (index 1), then went back to t1.
    expect(t.sessions.map((s) => s.trackId)).toEqual(['t2', 't1']);
    expect(engine.getSnapshot().track?.trackId).toBe('t1');
  });

  it('previous() at the head of the queue restarts the current track', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);
    driver.emit({ playing: true, currentTimeSec: 1, durationSec: 30 });

    engine.previous();
    await flush();

    expect(t.sessions).toHaveLength(1);
    expect(driver.seekCalls).toEqual([0]);
  });

  it('reports COMPLETE on natural finish, auto-advances, and ends the queue cleanly', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1'), track('t2')]);

    driver.emit({ didJustFinish: true, playing: false, currentTimeSec: 30, durationSec: 30 });
    await flush();

    expect(t.events).toContainEqual({ sessionId: 'sess-1', type: 'COMPLETE', positionMs: 30000 });
    expect(t.sessions.map((s) => s.trackId)).toEqual(['t1', 't2']);

    driver.emit({ playing: true, currentTimeSec: 0, durationSec: 25 });
    await flush();
    driver.emit({ didJustFinish: true, playing: false, currentTimeSec: 25, durationSec: 25 });
    await flush();

    expect(t.events).toContainEqual({ sessionId: 'sess-2', type: 'COMPLETE', positionMs: 25000 });
    const snap = engine.getSnapshot();
    expect(snap.state).toBe('ended');
    expect(snap.queue).toHaveLength(2); // queue kept for replay
    expect(driver.maxConcurrentPlayers).toBeLessThanOrEqual(1);
  });

  it('sends HEARTBEAT on a cadence while playing and stops on pause', async () => {
    jest.useFakeTimers();
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api, { heartbeatIntervalMs: 15_000 });
    await engine.setQueue([track('t1')]);
    driver.emit({ playing: true, currentTimeSec: 1, durationSec: 30 });
    await flush();
    expect(t.events.map((e) => e.type)).toEqual(['START']);

    driver.emit({ playing: true, currentTimeSec: 5, durationSec: 30 });
    jest.advanceTimersByTime(45_000);
    await flush();

    const heartbeats = t.events.filter((e) => e.type === 'HEARTBEAT');
    expect(heartbeats).toHaveLength(3);
    expect(heartbeats[0]).toEqual({ sessionId: 'sess-1', type: 'HEARTBEAT', positionMs: 5000 });

    engine.pause();
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(t.events.filter((e) => e.type === 'HEARTBEAT')).toHaveLength(3);
  });

  it('resumes HEARTBEAT after pause/resume', async () => {
    jest.useFakeTimers();
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api, { heartbeatIntervalMs: 15_000 });
    await engine.setQueue([track('t1')]);
    driver.emit({ playing: true, currentTimeSec: 1, durationSec: 30 });
    await flush();

    engine.pause();
    jest.advanceTimersByTime(30_000);
    engine.play(); // resume: driver publishes playing again
    jest.advanceTimersByTime(15_000);
    await flush();

    expect(t.events.filter((e) => e.type === 'HEARTBEAT')).toHaveLength(1);
  });

  it('telemetry failures never break playback', async () => {
    const seen: { error: unknown; context: string }[] = [];
    const t = createTestApi({ failEvents: true });
    const { engine, driver } = createEngine(t.api, {
      onEngineError: (error, context) => seen.push({ error, context }),
    });
    await engine.setQueue([track('t1')]);
    driver.emit({ playing: true, currentTimeSec: 0, durationSec: 30 });
    await flush();

    expect(engine.getSnapshot().state).toBe('playing');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].context).toBe('reportPlayEvent(START)');
  });

  it('reports ERROR with the last position when the player errors', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);
    driver.emit({ playing: true, currentTimeSec: 12, durationSec: 30 });

    driver.emit({ error: 'network lost', playing: false });
    await flush();

    const snap = engine.getSnapshot();
    expect(snap.state).toBe('error');
    expect(snap.error).toBe('network lost');
    expect(t.events).toContainEqual({ sessionId: 'sess-1', type: 'ERROR', positionMs: 12000 });
  });

  it('retry() mints a fresh session and resumes at the last position', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);
    driver.emit({ playing: true, currentTimeSec: 12, durationSec: 30 });
    driver.emit({ error: 'network lost', playing: false });
    await flush();
    expect(engine.getSnapshot().state).toBe('error');

    await engine.retry();
    await flush();

    expect(t.sessions).toHaveLength(2);
    expect(t.sessions[1].trackId).toBe('t1');
    // Resume seek applied from the initial loaded status during load().
    expect(driver.seekCalls).toEqual([12000]);

    driver.emit({ playing: true, currentTimeSec: 12, durationSec: 30 });
    await flush();
    expect(t.events).toContainEqual({ sessionId: 'sess-2', type: 'START', positionMs: 0 });
  });

  it('play() from the error state retries with a fresh session', async () => {
    const t = createTestApi();
    const driver = new FakeAudioDriver();
    const { engine } = createEngine(t.api, { driver });
    driver.loadError = 'boom';
    await engine.setQueue([track('t1')]);
    expect(engine.getSnapshot().state).toBe('error');

    driver.loadError = null;
    engine.play();
    await flush();

    expect(t.sessions).toHaveLength(2);
    expect(driver.loadCalls).toHaveLength(2);
  });

  it('reports ERROR when the player fails to load (session exists)', async () => {
    const t = createTestApi();
    const driver = new FakeAudioDriver();
    driver.loadError = 'codec exploded';
    const { engine } = createEngine(t.api, { driver });

    await engine.setQueue([track('t1')]);
    await flush();

    expect(engine.getSnapshot().state).toBe('error');
    expect(t.events).toContainEqual({ sessionId: 'sess-1', type: 'ERROR', positionMs: 0 });
  });

  it('surfaces session-creation failure as error state without an ERROR event', async () => {
    const t = createTestApi({ failSessionFor: new Set(['t9']) });
    const { engine } = createEngine(t.api);

    await engine.setQueue([track('t9')]);

    const snap = engine.getSnapshot();
    expect(snap.state).toBe('error');
    expect(snap.error).toMatch(/denied/i);
    // No session id exists, so there is nothing to report against.
    expect(t.events).toHaveLength(0);
  });

  it('aborts a pending load when stop() wins the race', async () => {
    const t = createTestApi({ holdSessions: true });
    const { engine, driver } = createEngine(t.api);
    const pending = engine.setQueue([track('t1')]);
    await flush();
    expect(engine.getSnapshot().state).toBe('loading');

    engine.stop();
    t.releaseSessions();
    await pending;
    await flush();

    expect(driver.loadCalls).toHaveLength(0);
    expect(engine.getSnapshot().state).toBe('idle');
    // The session was minted, then correctly discarded.
    expect(t.sessions).toHaveLength(1);
  });

  it('aborts a superseded load when skipping quickly', async () => {
    const t = createTestApi({ holdSessions: true });
    const { engine, driver } = createEngine(t.api);
    const first = engine.setQueue([track('t1')]);
    await flush();
    const second = engine.setQueue([track('t2')]);
    await flush();
    t.releaseSessions();
    await Promise.all([first, second]);
    await flush();

    // Only the second load finished; the first was superseded.
    expect(driver.loadCalls).toHaveLength(1);
    expect(driver.loadCalls[0]).toContain('token=tok-2');
    expect(engine.getSnapshot().track?.trackId).toBe('t2');
    expect(driver.maxConcurrentPlayers).toBeLessThanOrEqual(1);
  });

  it('enqueue appends; clearQueue stops and empties', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    await playTrack(engine, driver, [track('t1')]);

    engine.enqueue(track('t2'));
    expect(engine.getSnapshot().queue.map((q) => q.trackId)).toEqual(['t1', 't2']);

    engine.clearQueue();
    const snap = engine.getSnapshot();
    expect(snap.queue).toHaveLength(0);
    expect(snap.state).toBe('idle');
    expect(driver.destroyCalls).toBeGreaterThan(0);
  });

  it('ignores transport at the queue boundaries', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);

    engine.play(); // nothing queued
    await flush();
    expect(driver.loadCalls).toHaveLength(0);

    await playTrack(engine, driver, [track('t1')]);
    engine.next(); // already last
    await flush();
    expect(t.sessions).toHaveLength(1);

    driver.emit({ playing: true, currentTimeSec: 1, durationSec: 30 });
    engine.previous(); // head of queue: restart, no new session
    await flush();
    expect(t.sessions).toHaveLength(1);
    expect(driver.seekCalls).toEqual([0]);
  });

  it('subscribe() delivers the current snapshot immediately and stops on unsubscribe', async () => {
    const t = createTestApi();
    const { engine } = createEngine(t.api);
    const states: string[] = [];
    const unsubscribe = engine.subscribe((s) => states.push(s.state));
    expect(states).toEqual(['idle']);
    unsubscribe();
    await engine.setQueue([track('t1')]);
    expect(states).toEqual(['idle']);
  });

  it('destroy() releases the driver and drops listeners', async () => {
    const t = createTestApi();
    const { engine, driver } = createEngine(t.api);
    const states: string[] = [];
    engine.subscribe((s) => states.push(s.state));
    await playTrack(engine, driver, [track('t1')]);

    const seen = states.length;
    engine.destroy();

    expect(driver.destroyCalls).toBeGreaterThan(0);
    expect(engine.getSnapshot().queue).toHaveLength(0);
    driver.emit({ playing: true, currentTimeSec: 5, durationSec: 30 });
    expect(states.length).toBe(seen); // no listener fired after destroy
  });

  it('toQueueTrack maps a catalog summary', () => {
    const summary = {
      id: 't1',
      title: 'Song',
      durationMs: 30000,
      status: 'READY',
      artistId: 'a1',
      artistName: 'Artist',
      albumId: null,
      albumTitle: null,
    } satisfies TrackSummary;
    expect(toQueueTrack(summary)).toEqual({
      trackId: 't1',
      title: 'Song',
      artistName: 'Artist',
      albumTitle: null,
      artworkUrl: null,
      durationMs: 30000,
    });
  });
});
