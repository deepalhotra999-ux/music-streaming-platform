// Phase 11 — my playlists: the caller's own playlists (any visibility),
// newest first, with creation. Tapping a playlist opens its detail screen
// where rename/delete/track management live.

import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { PlaylistDetail, PlaylistListItem, PlaylistVisibility } from '../api';
import { apiErrorMessage, createPlaylist, listMyPlaylists } from '../api';
import { useAuth } from '../auth';
import { ArtworkImage, formatTrackCount, usePaginatedList } from '../catalog';
import { CollaborativeBadge, PlaylistForm, type PlaylistFormValues } from '../library';
import { LibraryList } from '../library/components/LibraryList';
import { Button } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

function visibilityLabel(visibility: PlaylistVisibility): string {
  switch (visibility) {
    case 'PUBLIC':
      return 'Public';
    case 'UNLISTED':
      return 'Unlisted';
    case 'PRIVATE':
      return 'Private';
  }
}

export function MyPlaylistsScreen() {
  const { api } = useAuth();
  const router = useRouter();
  const [formVisible, setFormVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fetchPage = useCallback((page: number) => listMyPlaylists(api, { page, limit: 20 }), [api]);
  const list = usePaginatedList(fetchPage);

  const create = useCallback(
    async (values: PlaylistFormValues) => {
      setSaving(true);
      setFormError(null);
      try {
        const created: PlaylistDetail = await createPlaylist(api, {
          title: values.title,
          description: values.description,
          visibility: values.visibility,
        });
        setFormVisible(false);
        router.push(`/playlist/${created.id}`);
      } catch (err) {
        setFormError(apiErrorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [api, router],
  );

  return (
    <>
      <LibraryList<PlaylistListItem>
        list={list}
        testID="my-playlists-screen"
        keyExtractor={(item) => item.id}
        emptyTitle="No playlists yet"
        emptyMessage="Create your first playlist to organize your music."
        emptyActionTitle="New playlist"
        onEmptyAction={() => setFormVisible(true)}
        listHeader={
          <View style={styles.header}>
            <Button
              title="New playlist"
              variant="secondary"
              size="md"
              onPress={() => setFormVisible(true)}
              testID="my-playlists-new"
            />
            <Button
              title="Join"
              variant="secondary"
              size="md"
              onPress={() => router.push('/invitation')}
              testID="my-playlists-join"
            />
          </View>
        }
        renderItem={(item) => (
          <Pressable
            onPress={() => router.push(`/playlist/${item.id}`)}
            accessibilityRole="button"
            accessibilityLabel={`Playlist ${item.title}`}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            testID={`my-playlist-row-${item.id}`}
          >
            <ArtworkImage uri={item.coverArtUrl} title={item.title} seed={item.id} size={56} />
            <View style={styles.texts}>
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.subtitle} numberOfLines={1}>
                {visibilityLabel(item.visibility)} • {formatTrackCount(item.trackCount)}
              </Text>
              {item.isCollaborative === true ? (
                <CollaborativeBadge testID={`my-playlist-collab-${item.id}`} />
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={fontSize.md} color={colors.textFaint} />
          </Pressable>
        )}
      />
      <PlaylistForm
        visible={formVisible}
        mode="create"
        saving={saving}
        error={formError}
        onSubmit={(input) => void create(input)}
        onClose={() => {
          if (!saving) {
            setFormVisible(false);
          }
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    gap: spacing.sm,
  },
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
    fontWeight: fontWeight.medium,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
});
