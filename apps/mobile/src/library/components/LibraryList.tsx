// Phase 11 — generic paginated library list.
//
// Same state handling as the catalog's CatalogListScreen (initial loading,
// empty, full-screen error with retry, pull-to-refresh, footer load-more),
// but driven by an explicit usePaginatedList handle so screens can trigger
// refresh/retry programmatically (e.g. after an unlike or unfollow).

import type { ReactElement } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { apiErrorMessage } from '../../api';
import { Button, EmptyState, ErrorState, LoadingState, Screen } from '../../components';
import type { PaginatedList } from '../../catalog';
import { colors, spacing } from '../../theme';

interface LibraryListProps<T> {
  list: PaginatedList<T>;
  renderItem: (item: T) => ReactElement | null;
  keyExtractor: (item: T) => string;
  emptyTitle: string;
  emptyMessage?: string;
  emptyActionTitle?: string;
  onEmptyAction?: () => void;
  listHeader?: ReactElement;
  testID?: string;
}

export function LibraryList<T>({
  list,
  renderItem,
  keyExtractor,
  emptyTitle,
  emptyMessage,
  emptyActionTitle,
  onEmptyAction,
  listHeader,
  testID,
}: LibraryListProps<T>) {
  const { items, loading, loadingMore, refreshing, error, hasMore, loadMore, refresh, retry } =
    list;

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
        testID="library-list"
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          <EmptyState
            title={emptyTitle}
            message={emptyMessage}
            actionTitle={emptyActionTitle}
            onAction={onEmptyAction}
            testID="library-empty"
          />
        }
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footer}>
              <ActivityIndicator color={colors.primary} testID="library-loading-more" />
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
});
