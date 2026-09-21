// Phase 6 — generic paginated catalog list screen.
//
// Wires usePaginatedList to a FlatList with the design-system states:
// initial loading, empty, full-screen error with retry, pull-to-refresh,
// and an inline footer spinner / retry affordance for load-more failures.

import type { ReactElement } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import type { Page } from '../../api';
import { apiErrorMessage } from '../../api';
import { Button, EmptyState, ErrorState, LoadingState, Screen } from '../../components';
import { colors, spacing } from '../../theme';
import { usePaginatedList } from '../hooks';

interface CatalogListScreenProps<T> {
  fetchPage: (page: number) => Promise<Page<T>>;
  renderItem: (item: T) => ReactElement;
  keyExtractor: (item: T) => string;
  emptyTitle: string;
  emptyMessage?: string;
  /** Rendered above the list (detail headers, section intros). */
  listHeader?: ReactElement;
  numColumns?: number;
  testID?: string;
}

export function CatalogListScreen<T>({
  fetchPage,
  renderItem,
  keyExtractor,
  emptyTitle,
  emptyMessage,
  listHeader,
  numColumns,
  testID,
}: CatalogListScreenProps<T>) {
  const { items, loading, loadingMore, refreshing, error, hasMore, loadMore, refresh, retry } =
    usePaginatedList(fetchPage);

  if (loading) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID={testID}>
        <LoadingState message="Loading…" />
      </Screen>
    );
  }

  if (error && items.length === 0) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID={testID}>
        <ErrorState message={apiErrorMessage(error)} onRetry={retry} />
      </Screen>
    );
  }

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID={testID}>
      <FlatList
        data={items}
        renderItem={({ item }) => renderItem(item)}
        keyExtractor={keyExtractor}
        numColumns={numColumns}
        key={numColumns ?? 1}
        testID="catalog-list"
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          <EmptyState title={emptyTitle} message={emptyMessage} testID="catalog-empty" />
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={colors.primary} testID="catalog-loading-more" />
            </View>
          ) : error && items.length > 0 ? (
            <View style={styles.footer}>
              <Button title="Load more" variant="secondary" size="md" onPress={retry} />
            </View>
          ) : null
        }
        onEndReached={() => {
          if (hasMore) {
            loadMore();
          }
        }}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />
        }
        contentContainerStyle={items.length === 0 ? styles.grow : undefined}
        columnWrapperStyle={numColumns ? styles.columns : undefined}
        removeClippedSubviews
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  grow: { flexGrow: 1 },
  footer: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  columns: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
});
