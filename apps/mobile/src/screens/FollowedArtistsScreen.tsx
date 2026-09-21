// Phase 11 — followed artists: the caller's paginated follows, newest
// first. Tapping an artist opens their profile; the follow button
// unfollows optimistically and the list refreshes to reflect it.

import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { FollowItem } from '../api';
import { listFollowedArtists } from '../api';
import { useAuth } from '../auth';
import { ArtistRow, usePaginatedList } from '../catalog';
import { FollowButton } from '../library';
import { LibraryList } from '../library/components/LibraryList';
import { spacing } from '../theme';

export function FollowedArtistsScreen() {
  const { api } = useAuth();
  const router = useRouter();

  const fetchPage = useCallback(
    (page: number) => listFollowedArtists(api, { page, limit: 20 }),
    [api],
  );
  const list = usePaginatedList(fetchPage);

  const handleToggled = useCallback(
    (followed: boolean) => {
      if (!followed) {
        list.refresh();
      }
    },
    [list],
  );

  return (
    <LibraryList<FollowItem>
      list={list}
      testID="followed-artists-screen"
      keyExtractor={(item) => item.artistId}
      emptyTitle="Not following anyone yet"
      emptyMessage="Follow artists to see them here."
      emptyActionTitle="Browse artists"
      onEmptyAction={() => router.push('/artists')}
      renderItem={(item) => (
        <View style={styles.rowWrap}>
          <View style={styles.rowFlex}>
            <ArtistRow
              artist={{
                id: item.artist.id,
                name: item.artist.name,
                verified: item.artist.verified,
                followerCount: 0,
                createdAt: item.createdAt,
              }}
              onPress={() => router.push(`/artist/${item.artistId}`)}
            />
          </View>
          <FollowButton artistId={item.artistId} onToggled={handleToggled} />
        </View>
      )}
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
