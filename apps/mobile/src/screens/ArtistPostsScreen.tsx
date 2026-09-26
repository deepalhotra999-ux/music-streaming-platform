// Phase 29 — all posts by one artist (public, ACTIVE only, newest first).
// Reached from the artist profile's "Posts" section.

import { useCallback } from 'react';
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { ArtistPost } from '../api';
import { apiErrorMessage, listArtistPosts } from '../api';
import { useAuth } from '../auth';
import { usePaginatedList } from '../catalog';
import { usePlayback } from '../playback';
import { EmptyState, ErrorState, LoadingState, Screen } from '../components';
import { colors, spacing } from '../theme';
import { PostCard } from '../community/components/PostCard';
import { useReactionToggle } from '../community/hooks/useReactionToggle';

export function ArtistPostsScreen() {
  const { artistId } = useLocalSearchParams<{ artistId: string }>();
  const { api } = useAuth();
  const router = useRouter();
  const { setQueue } = usePlayback();

  const fetchPage = useCallback(
    (page: number) => {
      if (!artistId) {
        return Promise.reject(new Error('Missing artist id'));
      }
      return listArtistPosts(api, artistId, { page, limit: 20 });
    },
    [api, artistId],
  );
  const list = usePaginatedList<ArtistPost>(fetchPage);
  const { applyOverrides, pending, toggle } = useReactionToggle(api);

  if (list.loading) {
    return (
      <Screen edges={['bottom']} testID="artist-posts-screen">
        <LoadingState message="Loading posts…" />
      </Screen>
    );
  }

  if (list.error && list.items.length === 0) {
    return (
      <Screen edges={['bottom']} testID="artist-posts-screen">
        <ErrorState message={apiErrorMessage(list.error)} onRetry={list.retry} />
      </Screen>
    );
  }

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="artist-posts-screen">
      <FlatList
        data={list.items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={list.refreshing}
            onRefresh={list.refresh}
            tintColor={colors.primary}
          />
        }
        onEndReached={list.loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          <EmptyState title="No posts yet" message="This artist hasn't posted anything." />
        }
        ListFooterComponent={
          list.loadingMore ? (
            <View style={styles.footer}>
              <LoadingState message="Loading more…" />
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <View style={styles.cardWrap}>
            <PostCard
              post={applyOverrides(item)}
              onOpen={(post) => router.push(`/post/${post.id}`)}
              onToggleReaction={toggle}
              onPlayTrack={(post) => {
                if (post.track) {
                  void setQueue(
                    [
                      {
                        trackId: post.track.id,
                        title: post.track.title,
                        artistName: post.track.artistName,
                        albumTitle: post.track.albumTitle,
                        durationMs: post.track.durationMs,
                      },
                    ],
                    0,
                  );
                }
              }}
              reactionPending={pending[item.id] === true}
            />
          </View>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    padding: spacing.md,
  },
  cardWrap: {
    marginBottom: spacing.sm,
  },
  footer: {
    paddingVertical: spacing.md,
  },
});
