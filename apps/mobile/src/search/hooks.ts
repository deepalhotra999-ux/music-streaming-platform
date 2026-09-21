// Phase 12 — search hooks.
//
// useDebouncedValue: shared debounce primitive (extracted from the
// AddTracksScreen pattern, 300 ms default). Fires only when the value
// settles, so typing "copper" issues one search instead of six.
//
// useSearch: runs a debounced multi-category search. States:
//   idle    — no query yet (recents/empty state territory)
//   loading — debounced query in flight
//   ready   — categorized results (possibly all empty → "no results")
//   error   — the query failed; retry re-issues the same debounced query
// A generation counter discards stale responses when the query changes
// mid-flight.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api';
import { searchCatalog } from './api';
import { emptyResults, type CategorizedResults } from './types';

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export type SearchState = 'idle' | 'loading' | 'ready' | 'error';

export interface SearchResult {
  state: SearchState;
  /** The debounced query the current state belongs to ('' when idle). */
  query: string;
  results: CategorizedResults;
  error: unknown;
  retry: () => void;
}

export function useSearch(client: ApiClient, query: string): SearchResult {
  const debouncedQuery = useDebouncedValue(query.trim());
  const [state, setState] = useState<SearchState>('idle');
  const [results, setResults] = useState<CategorizedResults>(emptyResults);
  const [error, setError] = useState<unknown>(null);
  const [retryKey, setRetryKey] = useState(0);
  const generation = useRef(0);

  const retry = useCallback(() => setRetryKey((k) => k + 1), []);

  useEffect(() => {
    if (!debouncedQuery) {
      generation.current += 1;
      setState('idle');
      setResults(emptyResults());
      setError(null);
      return;
    }
    const id = (generation.current += 1);
    setState('loading');
    setError(null);
    let cancelled = false;
    void searchCatalog(client, debouncedQuery)
      .then((res) => {
        if (cancelled || generation.current !== id) {
          return;
        }
        setResults(res);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled || generation.current !== id) {
          return;
        }
        setError(err);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, debouncedQuery, retryKey]);

  return { state, query: debouncedQuery, results, error, retry };
}
