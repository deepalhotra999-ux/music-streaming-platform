// Phase 25 — SecureStore authorization gate: the ONLY thing that decides
// whether a track may play offline. Fail-closed on every anomaly.

import * as SecureStore from 'expo-secure-store';
import {
  getAuthorization,
  isAuthorizationValid,
  removeAuthorization,
  saveAuthorization,
} from '../authorizationStore';
import type { OfflineAuthorizationRecord } from '../types';

const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => (mockStore.has(key) ? mockStore.get(key)! : null)),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

function record(overrides: Partial<OfflineAuthorizationRecord> = {}): OfflineAuthorizationRecord {
  const now = Date.now();
  return {
    authorizationId: 'authz-1',
    trackId: 'track-1',
    audioVersion: 3,
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 86_400_000).toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('authorizationStore', () => {
  it('round-trips a valid record and the gate accepts it', async () => {
    await saveAuthorization(record());
    const loaded = await getAuthorization('track-1');
    expect(loaded?.authorizationId).toBe('authz-1');
    expect(loaded && isAuthorizationValid(loaded)).toBe(true);
  });

  it('rejects expired grants', async () => {
    await saveAuthorization(record({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const loaded = await getAuthorization('track-1');
    expect(loaded).not.toBeNull();
    expect(isAuthorizationValid(loaded!)).toBe(false);
  });

  it('rejects revoked grants', async () => {
    await saveAuthorization(record({ revokedAt: new Date().toISOString() }));
    expect(isAuthorizationValid((await getAuthorization('track-1'))!)).toBe(false);
  });

  it('rejects grants used before issuance (clock skew / tampering)', async () => {
    await saveAuthorization(record({ issuedAt: new Date(Date.now() + 60_000).toISOString() }));
    expect(isAuthorizationValid((await getAuthorization('track-1'))!)).toBe(false);
  });

  it('treats corrupt SecureStore payloads as absent (fail closed)', async () => {
    await (SecureStore.setItemAsync as jest.Mock)('offline.authz.v1.track-1', 'not-json{{{');
    expect(await getAuthorization('track-1')).toBeNull();
  });

  it('treats schema-mismatched payloads as absent', async () => {
    await (SecureStore.setItemAsync as jest.Mock)(
      'offline.authz.v1.track-1',
      JSON.stringify({ authorizationId: 'x' }),
    );
    expect(await getAuthorization('track-1')).toBeNull();
  });

  it('returns null for unknown tracks', async () => {
    expect(await getAuthorization('nope')).toBeNull();
  });

  it('removeAuthorization deletes the record', async () => {
    await saveAuthorization(record());
    await removeAuthorization('track-1');
    expect(await getAuthorization('track-1')).toBeNull();
  });
});
