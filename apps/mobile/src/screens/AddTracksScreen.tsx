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
import {
  addTrackCollaborative,
  addTrackToPlaylist,
  apiErrorMessage,
  getPlaylist,
  isRevisionConflict,
  listTracks,
} from '../api';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../utils/useOnlineStatus';
import { TextInput } from '../components';
import { TrackRow, usePaginatedList } from '../catalog';
import { LibraryList } from '../library/components/LibraryList';
import { colors, fontSize, fontWeight, spacing } from '../theme';

export function AddTracksScreen({ playlistId }: { playlistId: string }) {
  const { api } = useAuth();
  // Phase 27 — collaborative add is disabled while offline.
  const online = useOnlineStatus();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [addingId, setAddingId] = useState<string | null>(null);
  // Phase 27 — revision for collaborative playlists (null until seeded).
  const [collab, setCollab] = useState<{ isCollaborative: boolean; revision: number } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Seed the "already added" set from the playlist detail so the picker
  // never offers a duplicate add for tracks already present. Phase 27:
  // also seeds the collaboration flag + revision for guarded writes.
  useEffect(() => {
    let cancelled = false;
    getPlaylist(api, playlistId)
      .then((detail) => {
        if (!cancelled) {
          setAddedIds(new Set(detail.items.map((item) => item.track.id)));
          setCollab({
            isCollaborative: detail.isCollaborative === true,
            revision: detail.revision ?? 0,
          });
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
        if (collab?.isCollaborative === true) {
          // Phase 27 — revision-guarded write; the authoritative new
          // revision feeds the next add.
          const result = await addTrackCollaborative(api, playlistId, {
            trackId: track.id,
            expectedRevision: collab.revision,
          });
          setCollab({ isCollaborative: true, revision: result.revision });
        } else {
          await addTrackToPlaylist(api, playlistId, { trackId: track.id });
        }
      } catch (err) {
        if (collab?.isCollaborative === true && isRevisionConflict(err)) {
          // Stale revision: the write was rejected server-side, so
          // nothing is committed. Refetch the fresh playlist, rebuild
          // the added set from it, and ask the user to retry.
          try {
            const detail = await getPlaylist(api, playlistId);
            setAddedIds(new Set(detail.items.map((item) => item.track.id)));
            setCollab({
              isCollaborative: detail.isCollaborative === true,
              revision: detail.revision ?? 0,
            });
          } catch {
            setAddedIds((prev) => {
              const next = new Set(prev);
              next.delete(track.id);
              return next;
            });
          }
          Alert.alert(
            'Playlist changed',
            'A collaborator changed this playlist — it was refreshed. Please try adding the track again.',
          );
        } else {
          setAddedIds((prev) => {
            const next = new Set(prev);
            next.delete(track.id);
            return next;
          });
          Alert.alert('Could not add track', apiErrorMessage(err));
        }
      } finally {
        setAddingId(null);
      }
    },
    [addingId, api, collab, playlistId],
  );

  const collabAddBlocked = collab?.isCollaborative === true && !online;

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
        {collabAddBlocked ? (
          <Text style={styles.offlineHint} testID="add-tracks-offline-hint">
            Collaborative editing is unavailable offline.
          </Text>
        ) : null}
      </View>
    ),
    [query, collabAddBlocked],
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Add tracks' }} />
      <LibraryList<TrackListItem>
        list={list}
        testID="add-tracks-screen"
        keyExtractor={(item) => item.id}
        emptyTitle="No tracks found"
        emptyMessage={debouncedQuery ? 'Try a different filter.' : 'No tracks are available yet.'}
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
                  disabled={busy || collabAddBlocked}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${track.title} to playlist`}
                  style={({ pressed }) => [styles.addButton, pressed && !busy && styles.pressed]}
                  testID={`add-tracks-add-${track.id}`}
                >
                  <Ionicons
                    name="add"
                    size={fontSize.md}
                    color={busy || collabAddBlocked ? colors.textFaint : colors.primary}
                  />
                  <Text style={[styles.addText, (busy || collabAddBlocked) && styles.addTextBusy]}>
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
  offlineHint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
  },
});
