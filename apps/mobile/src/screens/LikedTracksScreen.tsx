// Phase 11 — liked tracks: the caller's paginated likes, newest first.
// Tapping a track plays the visible likes from that track; the heart
// unlikes optimistically and the list refreshes to reflect it.

import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LikeItem } from '../api';
import { listLikedTracks } from '../api';
import { useAuth } from '../auth';
import { useQueueActions } from '../player';
import { TrackRow, usePaginatedList } from '../catalog';
import { LikeButton } from '../library';
import { LibraryList } from '../library/components/LibraryList';
import { spacing } from '../theme';

export function LikedTracksScreen() {
  const { api } = useAuth();
  const { playTracks, addToQueue } = useQueueActions();

  const fetchPage = useCallback(
    (page: number) => listLikedTracks(api, { page, limit: 20 }),
    [api],
  );
  const list = usePaginatedList(fetchPage);

  // Unliking flips the heart instantly (optimistic); once the unlike sticks,
  // refresh so the track leaves the list.
  const handleToggled = useCallback(
    (liked: boolean) => {
      if (!liked) {
        list.refresh();
      }
    },
    [list],
  );

  return (
    <LibraryList<LikeItem>
      list={list}
      testID="liked-tracks-screen"
      keyExtractor={(item) => item.trackId}
      emptyTitle="No liked tracks yet"
      emptyMessage="Tap the heart on any track to keep it here."
      renderItem={(item) => {
        const index = list.items.findIndex((entry) => entry.trackId === item.trackId);
        return (
          <View style={styles.rowWrap}>
            <View style={styles.rowFlex}>
              <TrackRow
                track={item.track}
                onPress={() =>
                  void playTracks(
                    list.items.map((entry) => entry.track),
                    Math.max(0, index),
                  )
                }
                onLongPress={() => void addToQueue(item.track)}
              />
            </View>
            <LikeButton trackId={item.trackId} onToggled={handleToggled} />
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  rowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.lg,
  },
  rowFlex: { flex: 1 },
});
