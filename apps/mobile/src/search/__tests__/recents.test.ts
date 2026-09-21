// Phase 12 — recent-search persistence tests.
//
// Uses an in-memory RecentSearchStorage double: the real AsyncStorage is
// exercised through the jest mock in the SearchScreen tests instead.

import {
  MAX_RECENT_SEARCHES,
  RECENT_SEARCHES_KEY,
  clearRecentSearches,
  loadRecentSearches,
  recordSearch,
  removeRecentSearch,
  type RecentSearchStorage,
} from '../recents';

function memoryStorage(seed: Record<string, string> = {}): RecentSearchStorage {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    getItem: async (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: async (key: string) => {
      store.delete(key);
    },
  };
}

describe('recent searches', () => {
  it('loads an empty list when nothing is stored', async () => {
    await expect(loadRecentSearches(memoryStorage())).resolves.toEqual([]);
  });

  it('records a search most-recent-first and persists it', async () => {
    const storage = memoryStorage();
    const recents = await recordSearch('  Copper Skyline ', storage);

    expect(recents).toHaveLength(1);
    expect(recents[0].query).toBe('Copper Skyline');
    expect(typeof recents[0].savedAt).toBe('string');

    // A fresh load sees the persisted entry.
    await expect(loadRecentSearches(storage)).resolves.toEqual(recents);
  });

  it('de-duplicates case-insensitively, moving the repeat to the front', async () => {
    const storage = memoryStorage();
    await recordSearch('neon coastline', storage);
    await recordSearch('glass horizon', storage);
    const recents = await recordSearch('NEON COASTLINE', storage);

    expect(recents.map((r) => r.query)).toEqual(['NEON COASTLINE', 'glass horizon']);
  });

  it('caps the list at MAX_RECENT_SEARCHES', async () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_RECENT_SEARCHES + 4; i++) {
      await recordSearch(`query ${i}`, storage);
    }
    const recents = await loadRecentSearches(storage);
    expect(recents).toHaveLength(MAX_RECENT_SEARCHES);
    expect(recents[0].query).toBe(`query ${MAX_RECENT_SEARCHES + 3}`);
    expect(recents[MAX_RECENT_SEARCHES - 1].query).toBe('query 4');
  });

  it('ignores empty and whitespace-only queries', async () => {
    const storage = memoryStorage();
    await recordSearch('   ', storage);
    await recordSearch('', storage);
    await expect(loadRecentSearches(storage)).resolves.toEqual([]);
  });

  it('removes a single recent search case-insensitively', async () => {
    const storage = memoryStorage();
    await recordSearch('neon coastline', storage);
    await recordSearch('glass horizon', storage);

    const recents = await removeRecentSearch('NEON coastline', storage);
    expect(recents.map((r) => r.query)).toEqual(['glass horizon']);
  });

  it('clearRecentSearches wipes the list', async () => {
    const storage = memoryStorage();
    await recordSearch('neon coastline', storage);
    await recordSearch('glass horizon', storage);

    await expect(clearRecentSearches(storage)).resolves.toEqual([]);
    await expect(loadRecentSearches(storage)).resolves.toEqual([]);
  });

  it('degrades to an empty list on corrupt or non-array stored JSON', async () => {
    const corrupt = memoryStorage({ [RECENT_SEARCHES_KEY]: 'not-json{{' });
    await expect(loadRecentSearches(corrupt)).resolves.toEqual([]);

    const nonArray = memoryStorage({ [RECENT_SEARCHES_KEY]: JSON.stringify({ query: 'x' }) });
    await expect(loadRecentSearches(nonArray)).resolves.toEqual([]);

    const badEntries = memoryStorage({
      [RECENT_SEARCHES_KEY]: JSON.stringify([{ query: 'ok' }, { nope: 1 }, null, 'str']),
    });
    const recents = await loadRecentSearches(badEntries);
    expect(recents.map((r) => r.query)).toEqual(['ok']);
  });
});
