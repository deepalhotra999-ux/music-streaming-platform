// Phase 11 — recently played: the caller's paginated listening history,
// newest first. Each row shows when the track was played; tapping plays the
// visible history from that track through the shared queue.

import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { HistoryItem } from '../api';
import { listHistory } from '../api';
import { useAuth } from '../auth';
import { useQueueActions } from '../player';
import { ArtworkImage, formatDuration, usePaginatedList } from '../catalog';
import { LikeButton, formatRelativeTime } from '../library';
import { LibraryList } from '../library/components/LibraryList';
import { colors, fontSize, spacing } from '../theme';

export function RecentlyPlayedScreen() {
  const { api } = useAuth();
  const { playTracks, addToQueue } = useQueueActions();

  const fetchPage = useCallback((page: number) => listHistory(api, { page, limit: 20 }), [api]);
  const list = usePaginatedList(fetchPage);

  return (
    <LibraryList<HistoryItem>
      list={list}
      testID="recently-played-screen"
      keyExtractor={(item) => item.id}
      emptyTitle="Nothing played yet"
      emptyMessage="Tracks you play will show up here."
      renderItem={(item) => {
        const index = list.items.findIndex((entry) => entry.id === item.id);
        return (
          <Pressable
            onPress={() =>
              void playTracks(
                list.items.map((entry) => entry.track),
                Math.max(0, index),
              )
            }
            onLongPress={() => void addToQueue(item.track)}
            accessibilityRole="button"
            accessibilityLabel={`Play ${item.track.title} by ${item.track.artistName}`}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            testID={`history-row-${item.id}`}
          >
            <ArtworkImage
              uri={null}
              title={item.track.albumTitle ?? item.track.title}
              seed={item.track.albumId ?? item.track.id}
              size={48}
            />
            <View style={styles.texts}>
              <Text style={styles.title} numberOfLines={1}>
                {item.track.title}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {item.track.artistName} • Played {formatRelativeTime(item.playedAt)}
              </Text>
            </View>
            <Text style={styles.meta}>{formatDuration(item.track.durationMs)}</Text>
            <LikeButton trackId={item.trackId} />
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  pressed: { opacity: 0.7 },
  texts: { flex: 1, minWidth: 0 },
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '500',
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  meta: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontVariant: ['tabular-nums'],
  },
});
