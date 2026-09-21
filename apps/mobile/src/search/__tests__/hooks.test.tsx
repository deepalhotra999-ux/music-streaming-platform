// Phase 12 — search hook tests: debounce coalescing, the idle →
// loading → ready/error state machine, retry, and stale-query disposal.

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { searchCatalog } from '../api';
import { useDebouncedValue, useSearch } from '../hooks';
import { emptyResults } from '../types';

jest.mock('../api', () => ({
  searchCatalog: jest.fn(),
}));

const mockSearchCatalog = searchCatalog as jest.Mock;

const results = {
  ...emptyResults(),
  tracks: { items: [{ id: 't1', title: 'Copper Skyline' }], total: 1 },
};

const client = {} as never;

describe('useDebouncedValue', () => {
  it('emits the settled value after the delay and coalesces rapid changes', async () => {
    const { result, rerender } = renderHook((props: { value: string }) => useDebouncedValue(props.value, 300), {
      initialProps: { value: 'c' },
    });
    expect(result.current).toBe('c');

    rerender({ value: 'co' });
    rerender({ value: 'cop' });
    rerender({ value: 'copp' });
    // Still the original until the delay elapses.
    expect(result.current).toBe('c');

    await waitFor(() => expect(result.current).toBe('copp'));
  });

  it('resets the timer when the value keeps changing', async () => {
    jest.useFakeTimers();
    try {
      const { result, rerender } = renderHook((props: { value: string }) => useDebouncedValue(props.value, 300), {
        initialProps: { value: 'a' },
      });
      rerender({ value: 'ab' });
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(result.current).toBe('a');
      rerender({ value: 'abc' });
      act(() => {
        jest.advanceTimersByTime(200);
      });
      expect(result.current).toBe('a');
      act(() => {
        jest.advanceTimersByTime(300);
      });
      expect(result.current).toBe('abc');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('useSearch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchCatalog.mockResolvedValue(results);
  });

  it('stays idle on an empty query and never calls the API', async () => {
    const { result } = renderHook(() => useSearch(client, '   '));
    expect(result.current.state).toBe('idle');
    expect(result.current.query).toBe('');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(mockSearchCatalog).not.toHaveBeenCalled();
  });

  it('debounces typing into a single search: idle → loading → ready', async () => {
    const { result, rerender } = renderHook((props: { q: string }) => useSearch(client, props.q), {
      initialProps: { q: '' },
    });
    rerender({ q: 'c' });
    rerender({ q: 'co' });
    rerender({ q: 'copper' });

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(mockSearchCatalog).toHaveBeenCalledTimes(1);
    expect(mockSearchCatalog).toHaveBeenCalledWith(client, 'copper');
    expect(result.current.query).toBe('copper');
    expect(result.current.results).toBe(results);
    expect(result.current.error).toBeNull();
  });

  it('surfaces errors with a retry that re-issues the same query', async () => {
    mockSearchCatalog.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useSearch(client, 'neon'));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toEqual(new Error('network down'));

    mockSearchCatalog.mockResolvedValue(results);
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(mockSearchCatalog).toHaveBeenCalledTimes(2);
    expect(mockSearchCatalog).toHaveBeenLastCalledWith(client, 'neon');
  });

  it('discards a stale response when the query changes mid-flight', async () => {
    let resolveFirst!: (value: typeof results) => void;
    mockSearchCatalog.mockImplementationOnce(
      () =>
        new Promise<typeof results>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { result, rerender } = renderHook((props: { q: string }) => useSearch(client, props.q), {
      initialProps: { q: 'aaa' },
    });
    await waitFor(() => expect(mockSearchCatalog).toHaveBeenCalledWith(client, 'aaa'));

    // Second query resolves immediately while the first is still pending.
    mockSearchCatalog.mockResolvedValue({ ...emptyResults(), artists: { items: [], total: 0 } });
    rerender({ q: 'bbb' });
    await waitFor(() => expect(result.current.query).toBe('bbb'));

    // The stale first response must not overwrite the second query's state.
    await act(async () => {
      resolveFirst(results);
    });
    expect(result.current.query).toBe('bbb');
    expect(result.current.results).not.toBe(results);
  });

  it('returns to idle when the query is cleared', async () => {
    const { result, rerender } = renderHook((props: { q: string }) => useSearch(client, props.q), {
      initialProps: { q: 'neon' },
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    rerender({ q: '' });
    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(result.current.results).toEqual(emptyResults());
  });
});
