// Phase 25 — offline source gate: valid SecureStore record + media file,
// or nothing. Tampering with display metadata can never grant playback.

import { resolveOfflineSource } from '../offlineSource';
import { saveAuthorization } from '../authorizationStore';
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

// Only the existence checks matter here.
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

import * as FileSystem from 'expo-file-system/legacy';

function authz(overrides: Partial<OfflineAuthorizationRecord> = {}): OfflineAuthorizationRecord {
  return {
    authorizationId: 'authz-1',
    trackId: 'track-1',
    audioVersion: 2,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockSecureStore.clear();
  jest.clearAllMocks();
});

describe('resolveOfflineSource', () => {
  it('returns the file URI when the grant is valid and the file exists', async () => {
    await saveAuthorization(authz());
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    const source = await resolveOfflineSource('track-1');
    expect(source).not.toBeNull();
    expect(source!.uri).toContain('track-1');
    expect(source!.uri).toContain('audio.ts');
    expect(source!.authorization.authorizationId).toBe('authz-1');
  });

  it('returns null when no authorization record exists', async () => {
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    expect(await resolveOfflineSource('track-1')).toBeNull();
  });

  it('returns null when the authorization expired', async () => {
    await saveAuthorization(authz({ expiresAt: new Date(Date.now() - 1).toISOString() }));
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true });
    expect(await resolveOfflineSource('track-1')).toBeNull();
  });

  it('returns null when the media file is missing (auth alone is not enough)', async () => {
    await saveAuthorization(authz());
    (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: false });
    expect(await resolveOfflineSource('track-1')).toBeNull();
  });
});
