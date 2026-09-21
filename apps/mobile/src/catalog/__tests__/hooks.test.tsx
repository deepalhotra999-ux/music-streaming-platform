// Phase 6 — catalog data hook tests.

import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { Page } from '../../api';
import { useCatalogDetail, usePaginatedList } from '../hooks';

function pageOf<T>(items: T[], page: number, totalPages: number, total: number): Page<T> {
  return { data: items, pagination: { page, limit: 2, total, totalPages } };
}

describe('usePaginatedList', () => {
  it('loads the first page and reports hasMore', async () => {
    const fetchPage = jest.fn(async (page: number) => pageOf(['a', 'b'], page, 3, 6));
    const { result } = renderHook(() => usePaginatedList(fetchPage));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.items).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.total).toBe(6);
    expect(result.current.error).toBeNull();
  });

  it('appends pages on loadMore and stops at the last page', async () => {
    const fetchPage = jest.fn(async (page: number) =>
      pageOf([`p${page}a`, `p${page}b`], page, 2, 4),
    );
    const { result } = renderHook(() => usePaginatedList(fetchPage));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.loadMore();
    });
    expect(result.current.loadingMore).toBe(true);
    await waitFor(() => expect(result.current.loadingMore).toBe(false));

    expect(result.current.items).toEqual(['p1a', 'p1b', 'p2a', 'p2b']);
    expect(result.current.hasMore).toBe(false);

    // No-op once exhausted: no further fetch.
    const calls = fetchPage.mock.calls.length;
    act(() => {
      result.current.loadMore();
    });
    expect(fetchPage.mock.calls.length).toBe(calls);
  });

  it('refresh resets to the first page', async () => {
    const fetchPage = jest.fn(async (page: number) => pageOf([`p${page}`], page, 2, 2));
    const { result } = renderHook(() => usePaginatedList(fetchPage));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toEqual(['p1', 'p2']));

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(false));
    expect(result.current.items).toEqual(['p1']);
  });

  it('surfaces the error and recovers on retry', async () => {
    const boom = new Error('offline');
    const fetchPage = jest
      .fn<Promise<Page<string>>, [number]>()
      .mockRejectedValueOnce(boom)
      .mockImplementation(async (page: number) => pageOf(['ok'], page, 1, 1));
    const { result } = renderHook(() => usePaginatedList(fetchPage));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe(boom);
    expect(result.current.items).toEqual([]);

    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.items).toEqual(['ok']));
    expect(result.current.error).toBeNull();
  });

  it('ignores a stale response when the fetcher changes', async () => {
    let resolveFirst!: (p: Page<string>) => void;
    const first = jest.fn(
      (): Promise<Page<string>> => new Promise<Page<string>>((resolve) => (resolveFirst = resolve)),
    );
    const second = jest.fn(async (): Promise<Page<string>> => pageOf(['second'], 1, 1, 1));
    const { result, rerender } = renderHook(
      ({ fetcher }: { fetcher: (page: number) => Promise<Page<string>> }) =>
        usePaginatedList<string>(fetcher),
      { initialProps: { fetcher: first } },
    );

    rerender({ fetcher: second });
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Resolve the stale first request late; its items must not win.
    await act(async () => {
      resolveFirst(pageOf(['stale'], 1, 1, 1));
    });
    expect(result.current.items).toEqual(['second']);
  });
});

describe('useCatalogDetail', () => {
  it('loads the resource', async () => {
    const { result } = renderHook(() => useCatalogDetail(async () => ({ name: 'Ada' })));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ name: 'Ada' });
    expect(result.current.error).toBeNull();
  });

  it('surfaces errors and retries', async () => {
    const fetch = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce('back');
    const { result } = renderHook(() => useCatalogDetail(fetch));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual(new Error('gone'));

    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.data).toBe('back'));
    expect(result.current.error).toBeNull();
  });
});
