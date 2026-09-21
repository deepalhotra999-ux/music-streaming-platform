// Phase 6 — CatalogListScreen wiring tests: loading, items, empty, error,
// and load-more footer states.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { Page } from '../../../api';
import { CatalogListScreen } from '../CatalogListScreen';

function pageOf<T>(items: T[], page: number, totalPages: number): Page<T> {
  return {
    data: items,
    pagination: { page, limit: 2, total: items.length * totalPages, totalPages },
  };
}

describe('CatalogListScreen', () => {
  it('shows loading, then the items', async () => {
    render(
      <CatalogListScreen
        fetchPage={async () => pageOf(['a', 'b'], 1, 1)}
        renderItem={(item) => <Text>{item}</Text>}
        keyExtractor={(item) => item}
        emptyTitle="Nothing here"
      />,
    );
    expect(screen.getByTestId('loading-state')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    expect(screen.getByText('b')).toBeTruthy();
  });

  it('shows the empty state when the catalog is empty', async () => {
    render(
      <CatalogListScreen
        fetchPage={async () => pageOf([], 1, 0)}
        renderItem={(item: string) => <Text>{item}</Text>}
        keyExtractor={(item) => item}
        emptyTitle="Nothing here"
        emptyMessage="Try again later."
      />,
    );
    await waitFor(() => expect(screen.getByText('Nothing here')).toBeTruthy());
    expect(screen.getByText('Try again later.')).toBeTruthy();
  });

  it('shows the error state with a retry button', async () => {
    const fetchPage = jest
      .fn<Promise<Page<string>>, [number]>()
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce(pageOf(['recovered'], 1, 1));
    render(
      <CatalogListScreen
        fetchPage={fetchPage}
        renderItem={(item) => <Text>{item}</Text>}
        keyExtractor={(item) => item}
        emptyTitle="Nothing here"
      />,
    );
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeTruthy());
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByText('recovered')).toBeTruthy());
  });

  it('appends the next page on end reached', async () => {
    const fetchPage = jest.fn(async (page: number) => pageOf([`p${page}`], page, 2));
    render(
      <CatalogListScreen
        fetchPage={fetchPage}
        renderItem={(item) => <Text>{item}</Text>}
        keyExtractor={(item) => item}
        emptyTitle="Nothing here"
      />,
    );
    await waitFor(() => expect(screen.getByText('p1')).toBeTruthy());
    fireEvent(screen.getByTestId('catalog-list'), 'onEndReached');
    await waitFor(() => expect(screen.getByText('p2')).toBeTruthy());
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
