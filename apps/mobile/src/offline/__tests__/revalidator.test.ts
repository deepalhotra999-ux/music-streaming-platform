// Phase 25 — revalidator: local authorization records are updated ONLY
// from server responses. Fail-closed outcomes delete local auth + media.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { saveAuthorization } from '../authorizationStore';
import { newDownloadRecord, saveDownloadRecord } from '../metadataStore';
import { revalidateAll } from '../revalidator';
import type { OfflineAuthorizationRecord } from '../types';

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

// storage.ts uses the real expo-file-system/legacy; stub just the parts
// the revalidator touches (deleteTrackDir).
jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn(async () => undefined),
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  makeDirectoryAsync: jest.fn(async () => undefined),
  writeAsStringAsync: jest.fn(async () => undefined),
  readAsStringAsync: jest.fn(async () => ''),
  moveAsync: jest.fn(async () => undefined),
  readDirectoryAsync: jest.fn(async () => []),
  getFreeDiskStorageAsync: jest.fn(async () => 0),
  documentDirectory: 'file:///docs/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

function resetAll(): void {
  (AsyncStorage as unknown as { __reset: () => void }).__reset();
  mockSecureStore.clear();
  jest.clearAllMocks();
}

function authz(trackId: string): OfflineAuthorizationRecord {
  return {
    authorizationId: `authz-${trackId}`,
    trackId,
    audioVersion: 1,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    revokedAt: null,
  };
}

const META = { title: 'T', artistName: 'A', albumTitle: null, durationMs: 180000 };

async function seed(trackId: string): Promise<void> {
  await saveAuthorization(authz(trackId));
  await saveDownloadRecord({ ...newDownloadRecord(trackId, META), status: 'complete' });
}

function apiWith(results: Record<string, { status: string; expiresAt?: string }>) {
  return {
    post: jest.fn(async (path: string) => {
      const id = decodeURIComponent(path.split('/')[4]);
      const trackId = id.replace('authz-', '');
      const r = results[trackId] ?? {
        status: 'ok',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      return r;
    }),
  };
}

beforeEach(resetAll);

describe('revalidator', () => {
  it('slides the window on ok, from the server response only', async () => {
    await seed('t1');
    const newExpiry = new Date(Date.now() + 99_999_999).toISOString();
    const summary = await revalidateAll(
      apiWith({ t1: { status: 'ok', expiresAt: newExpiry } }) as never,
    );
    expect(summary).toMatchObject({ checked: 1, renewed: 1, invalidated: 0 });
    const raw = mockSecureStore.get('offline.authz.v1.t1');
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!).expiresAt).toBe(newExpiry);
  });

  it('keeps the existing window on entitlement_canceled (never extends)', async () => {
    await seed('t1');
    const before = JSON.parse(mockSecureStore.get('offline.authz.v1.t1')!).expiresAt;
    const summary = await revalidateAll(
      apiWith({ t1: { status: 'entitlement_canceled' } }) as never,
    );
    expect(summary).toMatchObject({ checked: 1, kept: 1 });
    expect(JSON.parse(mockSecureStore.get('offline.authz.v1.t1')!).expiresAt).toBe(before);
  });

  it('deletes local auth + media on revoked / entitlement_lost / track_unavailable', async () => {
    for (const [trackId, status] of [
      ['r1', 'revoked'],
      ['r2', 'entitlement_lost'],
      ['r3', 'track_unavailable'],
    ] as const) {
      await seed(trackId);
      const summary = await revalidateAll(apiWith({ [trackId]: { status } }) as never);
      expect(summary.invalidated).toBe(1);
      expect(mockSecureStore.has(`offline.authz.v1.${trackId}`)).toBe(false);
    }
  });

  it('marks version_mismatch as stale (re-download offered, never auto-played)', async () => {
    await seed('v1');
    const summary = await revalidateAll(apiWith({ v1: { status: 'version_mismatch' } }) as never);
    expect(summary.invalidated).toBe(1);
    expect(mockSecureStore.has('offline.authz.v1.v1')).toBe(false);
    const raw = await AsyncStorage.getItem('offline.downloads.record.v1.v1');
    expect(JSON.parse(raw!).status).toBe('stale');
  });

  it('skips tracks with no local authorization record', async () => {
    const summary = await revalidateAll(apiWith({}) as never);
    expect(summary.checked).toBe(0);
  });

  it('propagates network failures (caller decides on retry)', async () => {
    await seed('t1');
    const api = {
      post: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    await expect(revalidateAll(api as never)).rejects.toThrow('boom');
  });
});
