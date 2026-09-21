// Phase 6 — catalog data hooks.
//
// usePaginatedList: page-by-page loading for every catalog list screen.
// Appends pages, exposes loadMore/refresh/retry, and keeps the initial,
// load-more, and refresh states separate so the UI can render each correctly.
//
// useCatalogDetail: single-resource loading for detail screens.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../api';

export interface PaginatedList<T> {
  items: T[];
  /** True only on the very first load. */
  loading: boolean;
  /** True while a subsequent page is being appended. */
  loadingMore: boolean;
  /** True during pull-to-refresh. */
  refreshing: boolean;
  error: unknown;
  hasMore: boolean;
  total: number;
  loadMore: () => void;
  refresh: () => void;
  retry: () => void;
}

export function usePaginatedList<T>(fetchPage: (page: number) => Promise<Page<T>>): PaginatedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [total, setTotal] = useState(0);
  // Guards against stale responses when the fetcher identity changes
  // (e.g. navigating between artist detail pages reusing the hook).
  const requestId = useRef(0);
  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;

  const load = useCallback(
    async (targetPage: number, mode: 'initial' | 'more' | 'refresh') => {
      const id = (requestId.current += 1);
      if (mode === 'initial') {
        setLoading(true);
      } else if (mode === 'more') {
        setLoadingMore(true);
      } else {
        setRefreshing(true);
      }
      setError(null);
      try {
        const result = await fetchPageRef.current(targetPage);
        if (requestId.current !== id) {
          return; // A newer request superseded this one.
        }
        setItems((prev) => (targetPage === 1 ? result.data : [...prev, ...result.data]));
        setPage(targetPage);
        setTotal(result.pagination.total);
        setHasMore(targetPage < result.pagination.totalPages);
      } catch (err) {
        if (requestId.current !== id) {
          return;
        }
        setError(err);
        if (mode === 'initial') {
          setItems([]);
        }
        // On refresh failure the previous items stay visible; on load-more
        // failure the footer shows the retry affordance via `error`.
      } finally {
        if (requestId.current === id) {
          setLoading(false);
          setLoadingMore(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    load(1, 'initial');
    // Re-run when the fetcher identity changes (new filters/ids).
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || refreshing || !hasMore || error) {
      return;
    }
    load(page + 1, 'more');
  }, [loading, loadingMore, refreshing, hasMore, error, page, load]);

  const refresh = useCallback(() => {
    load(1, 'refresh');
  }, [load]);

  const retry = useCallback(() => {
    load(items.length === 0 ? 1 : page + 1, items.length === 0 ? 'initial' : 'more');
  }, [load, items.length, page]);

  return {
    items,
    loading,
    loadingMore,
    refreshing,
    error,
    hasMore,
    total,
    loadMore,
    refresh,
    retry,
  };
}

export interface CatalogDetail<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  retry: () => void;
}

export function useCatalogDetail<T>(fetch: () => Promise<T>, deps: unknown[] = []): CatalogDetail<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    const id = (requestId.current += 1);
    setLoading(true);
    setError(null);
    fetchRef
      .current()
      .then((result) => {
        if (requestId.current === id) {
          setData(result);
        }
      })
      .catch((err) => {
        if (requestId.current === id) {
          setError(err);
        }
      })
      .finally(() => {
        if (requestId.current === id) {
          setLoading(false);
        }
      });
  }, [...deps, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { data, loading, error, retry };
}
