// Phase 9 — LIVE verification of the Phase 9 playback surface against the
// real Phase 7 streaming API (requires the API on EXPO_PUBLIC_API_URL with
// dev audio generated: services/api `npm run audio:generate`).
//
// Run explicitly with `npm run test:live`.
//
// Drives the PlaybackEngine through the exact call sequence the new player
// UI makes (playTracks -> setQueue, addToQueue -> enqueue, transport,
// seek, playAt, removeAt, shuffle, repeat) using the fake audio driver — no
// real audio plays — but session creation, the exact HLS URIs the engine
// hands the player, segment delivery, and play-event reporting all run
// against the real backend. A green run proves the Phase 9 UI wiring
// matches the Phase 7 contract end to end.

import { execFile } from 'child_process';
import http from 'http';
import { ApiClient, getApiBaseUrl, listTracks, register } from '../../../api/index';
import type { TrackListItem } from '../../../api/types';
import { PlaybackEngine } from '../../PlaybackEngine';
import { toQueueTrack, type QueueTrack } from '../../types';
import { FakeAudioDriver } from '../fakeDriver';

/** Minimal fetch built on Node's http module (same pattern as engine.live). */
function nodeHttpFetch(url: string, init?: RequestInit): Promise<Response> {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers as Record<string, string> | undefined;
  if (rawHeaders) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => (data.length > 0 ? JSON.parse(data) : null),
            text: async () => data,
          } as Response);
        });
      },
    );
    req.on('error', reject);
    if (init?.body) {
      req.write(init.body as string);
    }
    req.end();
  });
}

const fetchFn = nodeHttpFetch as unknown as typeof fetch;
const RUN_ID = Date.now().toString(36);

const flush = async (rounds = 60) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

/**
 * Wait until the engine reaches the expected state. Session creation is
 * real HTTP here, so fixed microtask flushes are not enough — poll the
 * event loop instead.
 */
async function waitForState(
  engine: PlaybackEngine,
  state: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (engine.getSnapshot().state === state) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for state ${state}; got ${engine.getSnapshot().state}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

/** Probe the HLS URI with ffprobe; resolves true when the stream is playable. */
function probeHls(uri: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', uri],
      { timeout: 30_000 },
      (error, stdout) => resolve(!error && stdout.toString().includes('aac')),
    );
  });
}

describe('live Phase 9 player surface', () => {
  it(
    'plays a queue, seeks, jumps, edits the queue, shuffles, and repeats against real HLS',
    async () => {
      const anon = new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn });
      const registered = await register(anon, {
        email: `phase9-player-${RUN_ID}@example.com`,
        password: 'phase9-player-secret',
        displayName: 'Phase9 Player',
      });
      const api = new ApiClient({
        baseUrl: getApiBaseUrl(),
        fetchFn,
        getAccessToken: () => registered.tokens.accessToken,
      });

      // Pick three READY tracks that actually load dev audio through the engine.
      const page = await listTracks(api, { limit: 50 });
      const candidates = page.data.filter((t: TrackListItem) => t.status === 'READY');
      expect(candidates.length).toBeGreaterThanOrEqual(3);

      const engineErrors: { error: unknown; context: string }[] = [];
      const onEngineError = (error: unknown, context: string) =>
        engineErrors.push({ error, context });

      // Probe candidates with a throwaway engine: keep the first three
      // READY tracks that actually load dev audio.
      const playable: TrackListItem[] = [];
      {
        const probeDriver = new FakeAudioDriver();
        const probe = new PlaybackEngine({
          api,
          baseUrl: getApiBaseUrl(),
          driver: probeDriver,
          onEngineError,
        });
        try {
          for (const candidate of candidates) {
            if (playable.length >= 3) break;
            await probe.setQueue([toQueueTrack(candidate)]);
            // Settle on either success or error (a track without dev
            // audio fails session creation and is skipped).
            const deadline = Date.now() + 15_000;
            for (;;) {
              const s = probe.getSnapshot().state;
              if (s === 'playing' || s === 'error') break;
              if (Date.now() > deadline) {
                throw new Error('probe timed out');
              }
              await new Promise((resolve) => {
                setTimeout(resolve, 25);
              });
            }
            if (probe.getSnapshot().state !== 'error') {
              playable.push(candidate);
            }
            probe.stop();
            await flush();
          }
        } finally {
          probe.destroy();
        }
      }
      expect(playable).toHaveLength(3);

      const driver = new FakeAudioDriver();
      const engine = new PlaybackEngine({
        api,
        baseUrl: getApiBaseUrl(),
        driver,
        onEngineError,
      });
      try {
        const queue: QueueTrack[] = playable.map(toQueueTrack);
        const [t1, t2, t3] = queue;

        // playTracks(tracks, 0): the queue the UI builds on track tap.
        await engine.setQueue(queue, 0);
        await waitForState(engine, 'playing');
        expect(engine.getSnapshot().track?.trackId).toBe(t1.trackId);
        expect(driver.loadCalls).toHaveLength(1);

        // The exact HLS URI the engine hands the player must be playable.
        const hlsUri = driver.loadCalls[0];
        const playlist = await fetchFn(hlsUri);
        expect(playlist.status).toBe(200);
        expect(await playlist.text()).toContain('#EXTM3U');
        expect(await probeHls(hlsUri)).toBe(true);

        // Transport: pause / resume via the mini-player toggle.
        await engine.toggle();
        await flush();
        expect(engine.getSnapshot().state).toBe('paused');
        await engine.toggle();
        await flush();
        expect(engine.getSnapshot().state).toBe('playing');

        // Seek: the full-player seek bar commit.
        await engine.seekTo(30_000);
        await flush();
        expect(driver.seekCalls).toContain(30_000);

        // Next / previous from the transport controls.
        await engine.next();
        await waitForState(engine, 'playing');
        expect(engine.getSnapshot().track?.trackId).toBe(t2.trackId);
        await engine.previous();
        await waitForState(engine, 'playing');
        expect(engine.getSnapshot().track?.trackId).toBe(t1.trackId);

        // Queue tap-to-jump: playAt(2).
        await engine.playAt(2);
        await waitForState(engine, 'playing');
        expect(engine.getSnapshot().track?.trackId).toBe(t3.trackId);

        // Queue remove: drop the earlier entry; current keeps playing.
        engine.removeAt(0);
        await flush();
        let snap = engine.getSnapshot();
        expect(snap.queue).toHaveLength(2);
        expect(snap.track?.trackId).toBe(t3.trackId);
        expect(snap.state).toBe('playing');

        // addToQueue long-press: appends to the end.
        engine.enqueue(t1);
        await flush();
        expect(engine.getSnapshot().queue).toHaveLength(3);

        // Shuffle: flag flips, current and queue length are preserved.
        engine.setShuffle(true);
        await flush();
        snap = engine.getSnapshot();
        expect(snap.shuffle).toBe(true);
        expect(snap.queue).toHaveLength(3);
        expect(snap.track?.trackId).toBe(t3.trackId);
        engine.setShuffle(false);
        await flush();
        expect(engine.getSnapshot().shuffle).toBe(false);

        // Repeat-all wraps natural completion at the queue edge.
        engine.setRepeatMode('all');
        await flush();
        expect(engine.getSnapshot().repeatMode).toBe('all');
        await engine.playAt(2); // last entry
        await waitForState(engine, 'playing');
        const loadsBeforeWrap = driver.loadCalls.length;
        driver.emit({ didJustFinish: true, playing: false });
        await waitForState(engine, 'playing');
        snap = engine.getSnapshot();
        expect(snap.trackIndex).toBe(0);
        expect(driver.loadCalls.length).toBeGreaterThan(loadsBeforeWrap);

        // Repeat-one replays the same track after natural completion.
        engine.setRepeatMode('one');
        await flush();
        const loadsBeforeOne = driver.loadCalls.length;
        driver.emit({ didJustFinish: true, playing: false });
        await waitForState(engine, 'playing');
        snap = engine.getSnapshot();
        expect(snap.trackIndex).toBe(0);
        expect(driver.loadCalls.length).toBeGreaterThan(loadsBeforeOne);

        // Repeat-off ends the queue at the edge.
        engine.setRepeatMode('off');
        await engine.playAt(2);
        await waitForState(engine, 'playing');
        driver.emit({ didJustFinish: true, playing: false });
        await waitForState(engine, 'ended');
        expect(engine.getSnapshot().state).toBe('ended');

        // Close (mini-player X): stop halts playback and clears the current
        // track (so the mini player hides) while keeping the queue.
        await engine.setQueue(queue, 0);
        await waitForState(engine, 'playing');
        await engine.stop();
        await flush();
        snap = engine.getSnapshot();
        expect(snap.state).toBe('idle');
        expect(snap.track).toBeNull();
        expect(snap.queue).toHaveLength(3);

        // Play events reported fire-and-forget with no engine errors.
        expect(engineErrors).toEqual([]);
        expect(driver.maxConcurrentPlayers).toBeLessThanOrEqual(1);
      } finally {
        engine.destroy();
      }
    },
    120_000,
  );
});
