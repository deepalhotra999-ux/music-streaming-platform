// Phase 25 — DownloadManager: authorize → fetch → assemble → verify →
// commit, with genuine segment-granular pause/resume, bounded
// concurrency, duplicate prevention, and fail-closed verification.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { DownloadManager, type TrackMeta } from '../downloadManager';
import { getDownloadRecord } from '../metadataStore';
import { audioFile } from '../storage';
import { base64ToBytes } from '../base64';

const mockSecureStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) =>
    mockSecureStore.has(key) ? mockSecureStore.get(key)! : null,
  ),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockSecureStore.delete(key);
  }),
}));

// -- in-memory expo-file-system ------------------------------------------------
// NOTE: the factory must be a self-contained inline object: referencing an
// outer variable directly from the factory body breaks under hoisting.
// The in-memory file map is created inside and exposed as __files.

jest.mock('expo-file-system/legacy', () => {
  const files = new Map<string, string>();
  const prefixOf = (uri: string): string => (uri.endsWith('/') ? uri : `${uri}/`);
  return {
    documentDirectory: 'file:///docs/',
    EncodingType: { Base64: 'base64', UTF8: 'utf8' },
    __files: files,
    makeDirectoryAsync: jest.fn(async () => undefined),
    deleteAsync: jest.fn(async (uri: string) => {
      for (const key of [...files.keys()]) {
        if (key === uri || key.startsWith(prefixOf(uri))) {
          files.delete(key);
        }
      }
    }),
    getInfoAsync: jest.fn(async (uri: string) => {
      if (files.has(uri)) {
        return { exists: true, isDirectory: false, size: files.get(uri)!.length };
      }
      return { exists: false, isDirectory: false };
    }),
    writeAsStringAsync: jest.fn(async (uri: string, contents: string) => {
      files.set(uri, contents);
    }),
    readAsStringAsync: jest.fn(async (uri: string) => {
      if (!files.has(uri)) throw new Error(`missing file ${uri}`);
      return files.get(uri)!;
    }),
    moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
      if (!files.has(from)) throw new Error(`missing file ${from}`);
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    getFreeDiskStorageAsync: jest.fn(async () => 1024 * 1024 * 1024),
  };
});

import * as MockFileSystem from 'expo-file-system/legacy';

function mockFiles(): Map<string, string> {
  return (MockFileSystem as unknown as { __files: Map<string, string> }).__files;
}

// -- fakes --------------------------------------------------------------------

const META: TrackMeta = { title: 'T', artistName: 'A', albumTitle: 'AL', durationMs: 12000 };

const SEG0 = new Uint8Array([0, 1, 2, 3, 4, 5]);
const SEG1 = new Uint8Array([6, 7, 8, 9]);

function grantFor(trackId: string) {
  const now = Date.now();
  return {
    authorizationId: `authz-${trackId}`,
    token: 'delivery-token',
    downloadTokenExpiresAt: new Date(now + 3600_000).toISOString(),
    expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    audioVersion: 1,
    track: { id: trackId, title: 'T', artistName: 'A', albumTitle: 'AL', durationMs: 12000 },
    downloadUrl: `/v1/offline/downloads/hls/master.m3u8?token=delivery-token`,
  };
}

interface FetchBehavior {
  hangSegments?: Set<string>;
  segmentCalls?: Map<string, number>;
  /** While true, matching segments hang until releaseHanging() is called. */
  keepHanging?: boolean;
  releaseHanging?: () => void;
}

function createFetchFn(behavior: FetchBehavior = {}) {
  const hangingReleases = new Map<string, () => void>();
  const fn = jest.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    const u = new URL(url);
    const path = u.pathname;
    const textResponse = (text: string) => ({
      ok: true,
      status: 200,
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    });
    if (path.endsWith('master.m3u8')) {
      return textResponse(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nrendition.m3u8?token=delivery-token\n',
      );
    }
    if (path.endsWith('rendition.m3u8')) {
      return textResponse(
        '#EXTM3U\n#EXTINF:6.0,\nseg0.ts?token=delivery-token\n#EXTINF:6.0,\nseg1.ts?token=delivery-token\n#EXT-X-ENDLIST\n',
      );
    }
    const segMatch = path.match(/(seg\d\.ts)$/);
    if (segMatch) {
      const name = segMatch[1];
      behavior.segmentCalls?.set(name, (behavior.segmentCalls?.get(name) ?? 0) + 1);
      const bytes = name === 'seg0.ts' ? SEG0 : SEG1;
      if (behavior.hangSegments?.has(name) && behavior.keepHanging !== false) {
        // Hang until released or aborted.
        await new Promise<void>((resolve, reject) => {
          const release = () => resolve();
          hangingReleases.set(name, release);
          behavior.releaseHanging = () => {
            for (const r of hangingReleases.values()) r();
            hangingReleases.clear();
          };
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
      return {
        ok: true,
        status: 200,
        text: async () => '',
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return fn;
}

function createApi(opts: { failAuthorize?: boolean } = {}) {
  const calls: string[] = [];
  let failNext = opts.failAuthorize ?? false;
  return {
    calls,
    post: jest.fn(async (path: string, body: { trackId?: string }) => {
      calls.push(path);
      if (path === '/v1/offline/downloads/authorize') {
        if (failNext) {
          failNext = false;
          throw new Error('denied');
        }
        return grantFor(body.trackId!);
      }
      throw new Error(`unexpected post ${path}`);
    }),
    setFailNextAuthorize() {
      failNext = true;
    },
  };
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function resetAll(): void {
  (AsyncStorage as unknown as { __reset: () => void }).__reset();
  mockSecureStore.clear();
  mockFiles().clear();
  jest.clearAllMocks();
}

beforeEach(resetAll);
afterEach(async () => {
  // Managers are stopped per-test via manager.stop() where created.
});

describe('DownloadManager', () => {
  it('downloads, assembles, verifies, and commits a track', async () => {
    const api = createApi();
    const fetchFn = createFetchFn();
    const manager = new DownloadManager({
      api: api as never,
      baseUrl: 'https://api.example.com',
      fs: MockFileSystem as never,
      fetchFn: fetchFn as never,
    });

    await manager.enqueue('t1', META);
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'complete');

    const record = await getDownloadRecord('t1');
    expect(record?.status).toBe('complete');
    expect(record?.authorizationId).toBe('authz-t1');
    expect(record?.audioVersion).toBe(1);

    // The assembled file is exactly seg0 + seg1.
    const stored = await (
      MockFileSystem as unknown as { readAsStringAsync: (uri: string) => Promise<string> }
    ).readAsStringAsync(audioFile('t1'));
    expect(base64ToBytes(stored)).toEqual(new Uint8Array([...SEG0, ...SEG1]));

    // The authorization record (the offline playback gate) was persisted.
    const authRaw = mockSecureStore.get('offline.authz.v1.t1');
    expect(authRaw).toBeDefined();
    expect(JSON.parse(authRaw!).authorizationId).toBe('authz-t1');

    // Token-scoped URLs were used for every fetch.
    for (const call of fetchFn.mock.calls) {
      expect(call[0]).toContain('token=delivery-token');
    }
    await manager.stop();
  });

  it('never leaves a playable partial file: failed downloads keep only segments', async () => {
    const api = createApi();
    const fetchFn = createFetchFn();
    const manager = new DownloadManager({
      api: api as never,
      baseUrl: 'https://api.example.com',
      fs: MockFileSystem as never,
      fetchFn: fetchFn as never,
    });
    // Break the rendition fetch: no segments listed.
    (fetchFn as jest.Mock).mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await manager.enqueue('t1', META);
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'failed');
    // audio.ts was never committed.
    expect(mockFiles().has(audioFile('t1'))).toBe(false);
    await manager.stop();
  });

  it('pauses mid-download and resumes from the first missing segment', async () => {
    const api = createApi();
    const segmentCalls = new Map<string, number>();
    const behavior: FetchBehavior = { hangSegments: new Set(['seg1.ts']), segmentCalls };
    const fetchFn = createFetchFn(behavior);
    const manager = new DownloadManager({
      api: api as never,
      baseUrl: 'https://api.example.com',
      fs: MockFileSystem as never,
      fetchFn: fetchFn as never,
    });

    await manager.enqueue('t1', META);
    // seg0 completes, seg1 hangs.
    await waitFor(async () => (await getDownloadRecord('t1'))?.resumeSegment === 1);

    await manager.pause('t1');
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'paused');
    const paused = await getDownloadRecord('t1');
    expect(paused?.resumeSegment).toBe(1);

    // Resume: open the hang gate so the seg1 retry resolves, and confirm
    // seg0 is NOT re-fetched.
    behavior.keepHanging = false;
    await manager.resume('t1');
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'complete');
    expect(segmentCalls.get('seg0.ts')).toBe(1);
    expect(segmentCalls.get('seg1.ts')).toBe(2);
    const stored = await (
      MockFileSystem as unknown as { readAsStringAsync: (uri: string) => Promise<string> }
    ).readAsStringAsync(audioFile('t1'));
    expect(base64ToBytes(stored)).toEqual(new Uint8Array([...SEG0, ...SEG1]));
    await manager.stop();
  });

  it('retries a failed authorization with a fresh grant', async () => {
    const api = createApi();
    api.setFailNextAuthorize();
    const fetchFn = createFetchFn();
    const manager = new DownloadManager({
      api: api as never,
      baseUrl: 'https://api.example.com',
      fs: MockFileSystem as never,
      fetchFn: fetchFn as never,
    });

    await manager.enqueue('t1', META);
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'failed');
    expect((await getDownloadRecord('t1'))?.error).toContain('denied');

    await manager.retry('t1');
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'complete');
    expect(api.calls.filter((c) => c === '/v1/offline/downloads/authorize')).toHaveLength(2);
    await manager.stop();
  });

  it('is duplicate-safe: re-enqueueing a completed track does nothing', async () => {
    const api = createApi();
    const fetchFn = createFetchFn();
    const manager = new DownloadManager({
      api: api as never,
      baseUrl: 'https://api.example.com',
      fs: MockFileSystem as never,
      fetchFn: fetchFn as never,
    });
    await manager.enqueue('t1', META);
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'complete');
    await manager.enqueue('t1', META);
    await new Promise((r) => setTimeout(r, 100));
    expect(api.calls.filter((c) => c === '/v1/offline/downloads/authorize')).toHaveLength(1);
    await manager.stop();
  });

  it('bounds concurrency: with concurrency 1 the second track waits', async () => {
    const api = createApi();
    const behavior: FetchBehavior = {
      hangSegments: new Set(['seg0.ts', 'seg1.ts']),
      segmentCalls: new Map(),
    };
    const fetchFn = createFetchFn(behavior);
    const manager = new DownloadManager({
      api: api as never,
      baseUrl: 'https://api.example.com',
      concurrency: 1,
      fs: MockFileSystem as never,
      fetchFn: fetchFn as never,
    });
    await manager.enqueue('t1', META);
    await manager.enqueue('t2', META);
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'downloading');
    await new Promise((r) => setTimeout(r, 150));
    // t1 holds the only slot; t2 stays queued.
    expect((await getDownloadRecord('t2'))?.status).toBe('queued');
    // Open the gate and release t1's hanging segment; both finish.
    behavior.keepHanging = false;
    behavior.releaseHanging?.();
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'complete');
    await waitFor(async () => (await getDownloadRecord('t2'))?.status === 'complete');
    await manager.stop();
  });

  it('remove() deletes media, authorization, and metadata', async () => {
    const api = createApi();
    const fetchFn = createFetchFn();
    const manager = new DownloadManager({
      api: api as never,
      baseUrl: 'https://api.example.com',
      fs: MockFileSystem as never,
      fetchFn: fetchFn as never,
    });
    await manager.enqueue('t1', META);
    await waitFor(async () => (await getDownloadRecord('t1'))?.status === 'complete');
    await manager.remove('t1');
    expect(await getDownloadRecord('t1')).toBeNull();
    expect(mockSecureStore.has('offline.authz.v1.t1')).toBe(false);
    expect(mockFiles().has(audioFile('t1'))).toBe(false);
    await manager.stop();
  });

  it('fails fast when free storage is below the preflight estimate', async () => {
    (MockFileSystem.getFreeDiskStorageAsync as jest.Mock).mockResolvedValueOnce(1024);
    const api = createApi();
    const fetchFn = createFetchFn();
    const manager = new DownloadManager({
      api: api as never,
      baseUrl: 'https://api.example.com',
      fs: MockFileSystem as never,
      fetchFn: fetchFn as never,
    });
    await manager.enqueue('t-low', META);
    await waitFor(async () => (await getDownloadRecord('t-low'))?.status === 'failed');
    const record = await getDownloadRecord('t-low');
    expect(record?.error).toMatch(/storage/i);
    // No grant was minted for a doomed download.
    expect(api.calls.filter((c) => c === '/v1/offline/downloads/authorize')).toHaveLength(0);
    // No playable artifact left behind.
    expect(mockFiles().has(audioFile('t-low'))).toBe(false);
    await manager.stop();
  });
});
