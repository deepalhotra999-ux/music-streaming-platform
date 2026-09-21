// Phase 16 — shared list-fetching state for paginated admin tables.
// Every list page keeps: data, pagination, loading, error, a `reload()`
// retry entry point, and a `setPage()` helper that refetches.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../api/types';

export interface UseApiListResult<T, Q> {
  data: T[];
  total: number;
  pagination: Page<T>['pagination'] | null;
  page: number;
  loading: boolean;
  error: unknown;
  query: Q;
  setQuery: (patch: Partial<Q>) => void;
  setPage: (page: number) => void;
  reload: () => void;
}

export function useApiList<T, Q extends { page?: number; limit?: number }>(
  fetcher: (query: Q) => Promise<Page<T>>,
  initialQuery: Q,
): UseApiListResult<T, Q> {
  const [query, setQueryState] = useState<Q>(initialQuery);
  const [data, setData] = useState<T[]>([]);
  const [pagination, setPagination] = useState<Page<T>['pagination'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef(0);

  const fetchPage = useCallback(
    async (q: Q) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const result = await fetcher(q);
        if (requestId.current !== id) return; // stale response
        setData(result.data);
        setPagination(result.pagination);
      } catch (err) {
        if (requestId.current !== id) return;
        setError(err);
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    },
    [fetcher],
  );

  useEffect(() => {
    void fetchPage(query);
    // Intentionally not re-running on `query` object identity: state
    // updates below call fetchPage explicitly with the new query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  const applyQuery = useCallback(
    (next: Q) => {
      setQueryState(next);
      void fetchPage(next);
    },
    [fetchPage],
  );

  const setQuery = useCallback(
    (patch: Partial<Q>) => {
      applyQuery({ ...queryRef.current, ...patch, page: 1 });
    },
    [applyQuery],
  );

  const queryRef = useRef(query);
  queryRef.current = query;

  const setPage = useCallback(
    (page: number) => {
      applyQuery({ ...queryRef.current, page });
    },
    [applyQuery],
  );

  const reload = useCallback(() => {
    void fetchPage(queryRef.current);
  }, [fetchPage]);

  return {
    data,
    total: pagination?.total ?? 0,
    pagination,
    page: query.page ?? 1,
    loading,
    error,
    query,
    setQuery,
    setPage,
    reload,
  };
}
