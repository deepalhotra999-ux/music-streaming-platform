// Phase 11 — add tracks to an owned playlist.
//
// Paginated catalog track browser with a text filter (the same `q`
// dialect the catalog lists use — this is browsing with a filter, not the
// out-of-scope Search product). Tracks already in the playlist show an
// "Added" state; tapping Add calls the owner-only endpoint and flips the
// row optimistically, rolling back on failure.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import type { TrackListItem } from '../api';
import { addTrackToPlaylist, apiErrorMessage, getPlaylist, listTracks } from '../api';
import { useAuth } from '../auth';
import { TextInput } from '../components';
import { TrackRow, usePaginatedList } from '../catalog';
import { LibraryList } from '../library/components/LibraryList';
import { colors, fontSize, fontWeight, spacing } from '../theme';

export function AddTracksScreen({ playlistId }: { playlistId: string }) {
  const { api } = useAuth();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [addingId, setAddingId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Seed the "already added" set from the playlist detail so the picker
  // never offers a duplicate add for tracks already present.
  useEffect(() => {
    let cancelled = false;
    getPlaylist(api, playlistId)
      .then((detail) => {
        if (!cancelled) {
          setAddedIds(new Set(detail.items.map((item) => item.track.id)));
        }
      })
      .catch(() => {
        // A failed seed just means every row starts as addable; the API
        // still guards duplicates server-side.
      });
    return () => {
      cancelled = true;
    };
  }, [api, playlistId]);

  const fetchPage = useCallback(
    (page: number) =>
      listTracks(api, {
        page,
        limit: 20,
        q: debouncedQuery.length > 0 ? debouncedQuery : undefined,
      }),
    [api, debouncedQuery],
  );
  const list = usePaginatedList(fetchPage);

  const add = useCallback(
    async (track: TrackListItem) => {
      if (addingId) {
        return;
      }
      setAddingId(track.id);
      setAddedIds((prev) => new Set(prev).add(track.id));
      try {
        await addTrackToPlaylist(api, playlistId, { trackId: track.id });
      } catch (err) {
        setAddedIds((prev) => {
          const next = new Set(prev);
          next.delete(track.id);
          return next;
        });
        Alert.alert('Could not add track', apiErrorMessage(err));
      } finally {
        setAddingId(null);
      }
    },
    [addingId, api, playlistId],
  );

  const header = useMemo(
    () => (
      <View style={styles.searchWrap}>
        <TextInput
          label="Filter tracks"
          value={query}
          onChangeText={setQuery}
          placeholder="Title, artist…"
          returnKeyType="search"
          testID="add-tracks-search"
        />
      </View>
    ),
    [query],
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Add tracks' }} />
      <LibraryList<TrackListItem>
        list={list}
        testID="add-tracks-screen"
        keyExtractor={(item) => item.id}
        emptyTitle="No tracks found"
        emptyMessage={
          debouncedQuery ? 'Try a different filter.' : 'No tracks are available yet.'
        }
        listHeader={header}
        renderItem={(track) => {
          const added = addedIds.has(track.id);
          const busy = addingId === track.id;
          return (
            <View style={styles.rowWrap}>
              <View style={styles.rowFlex}>
                <TrackRow track={track} />
              </View>
              {added ? (
                <View
                  style={styles.addedBadge}
                  testID={`add-tracks-added-${track.id}`}
                  accessibilityLabel={`${track.title} already in playlist`}
                >
                  <Ionicons name="checkmark" size={fontSize.md} color={colors.primary} />
                  <Text style={styles.addedText}>Added</Text>
                </View>
              ) : (
                <Pressable
                  onPress={() => void add(track)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${track.title} to playlist`}
                  style={({ pressed }) => [styles.addButton, pressed && !busy && styles.pressed]}
                  testID={`add-tracks-add-${track.id}`}
                >
                  <Ionicons
                    name="add"
                    size={fontSize.md}
                    color={busy ? colors.textFaint : colors.primary}
                  />
                  <Text style={[styles.addText, busy && styles.addTextBusy]}>
                    {busy ? 'Adding…' : 'Add'}
                  </Text>
                </Pressable>
              )}
            </View>
          );
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  rowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.lg,
  },
  rowFlex: { flex: 1 },
  pressed: { opacity: 0.6 },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  addText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  addTextBusy: { color: colors.textFaint },
  addedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  addedText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
});
