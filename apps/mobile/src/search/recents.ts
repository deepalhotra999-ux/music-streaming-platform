// Phase 12 — recent searches stored on-device.
//
// Recent queries are device-local (AsyncStorage), never sent to the
// backend, and scoped to the device — signing out does not move them and
// they are not synced. The storage is injectable so tests can use an
// in-memory double; production passes the default AsyncStorage.
//
// A corrupted value degrades to an empty list rather than crashing the
// search screen.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RecentSearch } from './types';

export const RECENT_SEARCHES_KEY = 'waveform.search.recents.v1';
export const MAX_RECENT_SEARCHES = 10;

export interface RecentSearchStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const defaultStorage: RecentSearchStorage = AsyncStorage;

function parseStored(raw: string | null): RecentSearch[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is RecentSearch =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as RecentSearch).query === 'string' &&
        (entry as RecentSearch).query.length > 0,
    );
  } catch {
    return [];
  }
}

export async function loadRecentSearches(
  storage: RecentSearchStorage = defaultStorage,
): Promise<RecentSearch[]> {
  return parseStored(await storage.getItem(RECENT_SEARCHES_KEY));
}

async function persist(
  storage: RecentSearchStorage,
  recents: RecentSearch[],
): Promise<RecentSearch[]> {
  await storage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(recents));
  return recents;
}

function normalize(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Record a search: trimmed, de-duplicated (case-insensitive, moved to the
 * front), most-recent-first, capped at MAX_RECENT_SEARCHES. Returns the
 * updated list. Empty queries are ignored.
 */
export async function recordSearch(
  query: string,
  storage: RecentSearchStorage = defaultStorage,
): Promise<RecentSearch[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return loadRecentSearches(storage);
  }
  const key = normalize(trimmed);
  const existing = await loadRecentSearches(storage);
  const next: RecentSearch[] = [
    { query: trimmed, savedAt: new Date().toISOString() },
    ...existing.filter((entry) => normalize(entry.query) !== key),
  ].slice(0, MAX_RECENT_SEARCHES);
  return persist(storage, next);
}

/** Remove one recent search by query (case-insensitive). */
export async function removeRecentSearch(
  query: string,
  storage: RecentSearchStorage = defaultStorage,
): Promise<RecentSearch[]> {
  const key = normalize(query);
  const existing = await loadRecentSearches(storage);
  return persist(
    storage,
    existing.filter((entry) => normalize(entry.query) !== key),
  );
}

/** Clear all recent searches. */
export async function clearRecentSearches(
  storage: RecentSearchStorage = defaultStorage,
): Promise<RecentSearch[]> {
  await storage.removeItem(RECENT_SEARCHES_KEY);
  return [];
}
