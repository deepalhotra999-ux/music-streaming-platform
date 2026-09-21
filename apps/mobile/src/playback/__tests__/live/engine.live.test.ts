// Phase 8 — LIVE engine test against the real Phase 7 streaming API.
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000, with dev audio
// generated: services/api `npm run audio:generate`).
//
// Uses a fake audio driver — no real audio plays here — but session
// creation, the exact HLS URI the engine hands the player, and play-event
// reporting run against the real backend. A green run proves the engine
// matches the Phase 7 contract end to end.

import http from 'http';
import { ApiClient, getApiBaseUrl, listTracks, register } from '../../../api/index';
import type { TrackListItem } from '../../../api/types';
import { PlaybackEngine } from '../../PlaybackEngine';
import { toQueueTrack } from '../../types';
import { FakeAudioDriver } from '../fakeDriver';

/**
 * Minimal fetch built on Node's http module (same pattern as the other
 * live suites). Adds text() so the HLS playlist can be read raw.
 */
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

const flush = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

describe('live playback engine', () => {
  it('creates a real session, serves the HLS playlist, and records play events', async () => {
    const anon = new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn });
    const registered = await register(anon, {
      email: `phase8-engine-${RUN_ID}@example.com`,
      password: 'Phase8-test-pass!',
      displayName: 'Phase8 Engine',
    });
    const api = new ApiClient({
      baseUrl: getApiBaseUrl(),
      fetchFn,
      getAccessToken: () => registered.tokens.accessToken,
    });

    const page = await listTracks(api, { limit: 50 });
    const ready = page.data.find((t: TrackListItem) => t.status === 'READY');
    expect(ready).toBeDefined();

    const engineErrors: { error: unknown; context: string }[] = [];
    const driver = new FakeAudioDriver();
    const engine = new PlaybackEngine({
      api,
      baseUrl: getApiBaseUrl(),
      driver,
      onEngineError: (error, context) => engineErrors.push({ error, context }),
    });
    try {
      await engine.setQueue([toQueueTrack(ready!)]);
      expect(driver.loadCalls).toHaveLength(1);

      // The exact URI the engine hands the player must serve the playlist.
      const hlsUri = driver.loadCalls[0];
      const playlist = await fetchFn(hlsUri);
      expect(playlist.status).toBe(200);
      const body = await playlist.text();
      expect(body).toContain('#EXTM3U');

      // Drive the fake player through start -> finish.
      driver.emit({ playing: true, currentTimeSec: 0, durationSec: 30 });
      await flush();
      driver.emit({ didJustFinish: true, playing: false, currentTimeSec: 30, durationSec: 30 });
      await flush();

      expect(engine.getSnapshot().state).toBe('ended');
      // reportPlayEvent is fire-and-forget: any rejection (e.g. the API
      // refusing START/COMPLETE) surfaces here.
      expect(engineErrors).toEqual([]);
    } finally {
      engine.destroy();
    }
  }, 30_000);
});
