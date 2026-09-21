// Phase 14 — LIVE ingestion test: real audio upload -> transcode ->
// READY -> playback-session -> HLS, against the running API.
//
// Run explicitly with `npm run test:live` (requires the API on
// EXPO_PUBLIC_API_URL, default http://localhost:3000, ffmpeg on PATH,
// and the dev database).
//
// The jest-expo preset stubs global fetch even in the node live env, so
// this suite brings its own multipart-capable transport on Node's http
// module. It still drives the real ApiClient.upload (auth headers,
// status handling, RFC 7807 parsing); only the byte transport is bespoke.
// Everything created is cleaned up in afterAll.

import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { promisify } from 'util';
import {
  ApiClient,
  ApiError,
  createArtist,
  createPlaybackSession,
  createTrack,
  deleteArtist,
  deleteTrack,
  getApiBaseUrl,
  getAudioStatus,
  login,
  register,
} from '../../index';

const execFileAsync = promisify(execFile);
const API_DIR = resolve(__dirname, '../../../../../../services/api');

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = resolve(API_DIR, '.env');
  if (!existsSync(envPath)) throw new Error('services/api/.env was not found');
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DATABASE_URL='));
  if (!line) throw new Error('DATABASE_URL not found in services/api/.env');
  // .env values may be quote-wrapped; prisma rejects the quotes.
  return line.slice('DATABASE_URL='.length).replace(/^["']|["']$/g, '');
}

async function setRole(email: string, role: 'ARTIST'): Promise<void> {
  await execFileAsync('node', [resolve(API_DIR, 'scripts/set-user-role.mjs'), email, role], {
    env: { ...process.env, DATABASE_URL: loadDatabaseUrl() },
  });
}

interface RawInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
}

/** Minimal real-HTTP transport with multipart support. */
function rawHttpFetch(url: string, init?: RawInit): Promise<Response> {
  const target = new URL(url);
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers: init?.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolvePromise({
            ok: status >= 200 && status < 300,
            status,
            headers: new Map(Object.entries(res.headers ?? {})),
            json: async () => (text.length > 0 ? JSON.parse(text) : null),
            text: async () => text,
          } as unknown as Response);
        });
      },
    );
    req.on('error', reject);
    if (init?.body) req.write(init.body);
    req.end();
  });
}

const fetchFn = rawHttpFetch as unknown as typeof fetch;
const anon = new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn });

function authedClient(accessToken: string): ApiClient {
  return new ApiClient({ baseUrl: getApiBaseUrl(), fetchFn, getAccessToken: () => accessToken });
}

/** Build a multipart/form-data buffer with a single file field. */
function multipartBody(field: string, filename: string, contentType: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----live-${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, bytes, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Upload through the real ApiClient.upload with a hand-built multipart body. */
async function uploadAudio(accessToken: string, trackId: string, bytes: Buffer) {
  const { body, contentType } = multipartBody('audio', 'take.wav', 'audio/wav', bytes);
  // ApiClient.upload deliberately never sets Content-Type (fetch adds the
  // multipart boundary); the transport fills it in like a real client would.
  const client = new ApiClient({
    baseUrl: getApiBaseUrl(),
    fetchFn: ((url: string, init?: RawInit) =>
      rawHttpFetch(url, {
        ...init,
        headers: { ...(init?.headers ?? {}), 'Content-Type': contentType },
      })) as unknown as typeof fetch,
    getAccessToken: () => accessToken,
  });
  // The client under test is ApiClient.upload; the body shape is transport detail.
  return client.upload<{ audioStatus: string }>(`/v1/tracks/${trackId}/audio`, body as unknown as FormData);
}

async function makeWav(path: string): Promise<void> {
  // 8s mono sine — synthetic test audio only, never copyrighted material.
  await execFileAsync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=520:duration=8',
    '-c:a', 'pcm_s16le', path,
  ]);
}

describe('live audio ingestion', () => {
  const RUN_ID = Date.now().toString(36);
  const ARTIST_EMAIL = `waveform-ingest-${RUN_ID}@example.com`;
  const LISTENER_EMAIL = `waveform-ingest-listener-${RUN_ID}@example.com`;
  const PASSWORD = 'IngestLive-Pass-123!';

  let artist: ApiClient;
  let artistToken = '';
  let listenerToken = '';
  let artistId = '';
  let trackId = '';
  let wavBytes: Buffer;

  beforeAll(async () => {
    await register(anon, { email: ARTIST_EMAIL, password: PASSWORD, displayName: 'Live Ingest Artist' });
    await register(anon, { email: LISTENER_EMAIL, password: PASSWORD, displayName: 'Live Ingest Listener' });
    await setRole(ARTIST_EMAIL, 'ARTIST');

    const a = await login(anon, { email: ARTIST_EMAIL, password: PASSWORD });
    artistToken = a.tokens.accessToken;
    artist = authedClient(artistToken);
    const b = await login(anon, { email: LISTENER_EMAIL, password: PASSWORD });
    listenerToken = b.tokens.accessToken;

    const created = await createArtist(artist, { name: `Live Ingest Artist ${RUN_ID}` });
    artistId = created.id;

    const wavPath = join(tmpdir(), `live-ingest-${RUN_ID}.wav`);
    await makeWav(wavPath);
    wavBytes = readFileSync(wavPath);
  }, 60_000);

  afterAll(async () => {
    if (trackId) await deleteTrack(artist, trackId).catch(() => {});
    if (artistId) await deleteArtist(artist, artistId).catch(() => {});
  });

  it('uploads audio, processes to READY, and the HLS package plays through a session', async () => {
    const created = await createTrack(artist, {
      title: `Live Ingest Take ${RUN_ID}`,
      artistId,
      durationMs: 8000,
    });
    trackId = created.id;

    const accepted = await uploadAudio(artistToken, trackId, wavBytes);
    expect(accepted.audioStatus).toBe('PENDING');

    // A listener cannot touch the pipeline.
    const denied = await uploadAudio(listenerToken, trackId, wavBytes).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ApiError);
    expect((denied as ApiError).status).toBe(403);

    // Poll until the background worker finishes.
    let status = await getAudioStatus(artist, trackId);
    const deadline = Date.now() + 45_000;
    while ((status.audioStatus === 'PENDING' || status.audioStatus === 'PROCESSING') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      status = await getAudioStatus(artist, trackId);
    }
    expect(status.audioStatus).toBe('READY');
    expect(status.audioError).toBeNull();
    expect(status.audioReadyAt).not.toBeNull();

    // The processed track plays through the Phase 7 session flow.
    const session = await createPlaybackSession(artist, trackId);
    expect(session.hlsUrl).toContain('/v1/playback/hls/master.m3u8');
    const master = await rawHttpFetch(`${getApiBaseUrl()}${session.hlsUrl}`);
    const text = await master.text();
    expect(master.status).toBe(200);
    expect(text.startsWith('#EXTM3U')).toBe(true);
    expect(text).toContain('CODECS="mp4a.40.2"');
  }, 120_000);
});
