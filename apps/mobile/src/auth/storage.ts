// Phase 5 — secure key/value storage abstraction.
//
// Production implementation wraps expo-secure-store (iOS Keychain / Android
// Keystore). Auth tokens must NEVER live in AsyncStorage, plain files, or
// in-memory-only singletons that lose the session silently.
//
// The interface is injectable so AuthProvider and the session helpers are
// unit-testable with an in-memory double.

import * as SecureStore from 'expo-secure-store';

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createSecureStorage(): KeyValueStorage {
  return {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    removeItem: (key) => SecureStore.deleteItemAsync(key),
  };
}

/** In-memory double for tests and previews. Not for production use. */
export function createMemoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
}
