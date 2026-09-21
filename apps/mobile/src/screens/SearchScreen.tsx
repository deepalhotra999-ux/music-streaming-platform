// Phase 12 — functional search over the existing catalog.
//
// The Search tab is now a real multi-category search: a debounced input
// fires parallel `q` queries against the five Phase 4 list endpoints
// (artists, albums, tracks, genres, public playlists) and renders
// categorized results. Track taps play through the existing
// PlaybackEngine (long-press queues); every other row opens its existing
// detail screen. Recent queries persist on-device and can be re-run,
// removed individually, or cleared wholesale. No backend changes, no
// recommendations, no AI — just the catalog you can already browse.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { apiErrorMessage } from '../api';
import { useAuth } from '../auth';
import { EmptyState, ErrorState, LoadingState, Screen } from '../components';
import { useQueueActions } from '../player';
import {
  RecentSearches,
  SearchBar,
  SearchResults,
  clearRecentSearches,
  loadRecentSearches,
  recordSearch,
  removeRecentSearch,
  totalResultCount,
  useSearch,
  type RecentSearch,
  type SearchResultHandlers,
} from '../search';
import { colors, spacing } from '../theme';

export function SearchScreen() {
  const { api } = useAuth();
  const router = useRouter();
  const { playTracks, addToQueue } = useQueueActions();
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const search = useSearch(api, query);

  useEffect(() => {
    let cancelled = false;
    void loadRecentSearches().then((loaded) => {
      if (!cancelled) {
        setRecents(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const remember = useCallback((searched: string) => {
    void recordSearch(searched).then(setRecents);
  }, []);

  const handlers: SearchResultHandlers = useMemo(
    () => ({
      onArtistPress: (id: string) => {
        remember(search.query);
        router.push(`/artist/${id}`);
      },
      onAlbumPress: (id: string) => {
        remember(search.query);
        router.push(`/album/${id}`);
      },
      onGenrePress: (id: string) => {
        remember(search.query);
        router.push(`/genre/${id}`);
      },
      onPlaylistPress: (id: string) => {
        remember(search.query);
        router.push(`/playlist/${id}`);
      },
      onTrackPress: (index: number) => {
        const tracks = search.results.tracks.items;
        remember(search.query);
        void playTracks(tracks, index);
      },
      onTrackLongPress: (index: number) => {
        const track = search.results.tracks.items[index];
        if (track) {
          void addToQueue(track);
        }
      },
    }),
    [addToQueue, playTracks, remember, router, search.query, search.results],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    search.retry();
    setTimeout(() => setRefreshing(false), 500);
  }, [search]);

  const onSelectRecent = useCallback((recentQuery: string) => {
    setQuery(recentQuery);
  }, []);

  const onRemoveRecent = useCallback((recentQuery: string) => {
    void removeRecentSearch(recentQuery).then(setRecents);
  }, []);

  const onClearRecents = useCallback(() => {
    void clearRecentSearches().then(setRecents);
  }, []);

  return (
    <Screen scrollable={false} padded={false} testID="search-screen">
      <View style={styles.searchWrap}>
        <SearchBar value={query} onChangeText={setQuery} />
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {search.state === 'idle' ? (
          recents.length > 0 ? (
            <RecentSearches
              recents={recents}
              onSelect={onSelectRecent}
              onRemove={onRemoveRecent}
              onClearAll={onClearRecents}
            />
          ) : (
            <EmptyState
              title="Search the catalog"
              message="Find artists, albums, tracks, genres, and playlists."
              testID="search-empty"
            />
          )
        ) : search.state === 'loading' ? (
          <LoadingState message="Searching…" testID="search-loading" />
        ) : search.state === 'error' ? (
          <ErrorState
            message={apiErrorMessage(search.error)}
            onRetry={search.retry}
            testID="search-error"
          />
        ) : totalResultCount(search.results) === 0 ? (
          <EmptyState
            title={`No results for "${search.query}"`}
            message="Check the spelling or try a different search."
            testID="search-no-results"
          />
        ) : (
          <SearchResults results={search.results} handlers={handlers} />
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  content: {
    paddingBottom: spacing.xxl,
    flexGrow: 1,
  },
});
