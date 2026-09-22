// Phase 11 — playlist detail: cover header, track list, and (for the
// owner) full playlist management.
//
// Everyone can play the playlist through the shared queue and like
// tracks. The owner additionally gets: rename/description/visibility
// editing, track adding (via the picker screen), track removal, track
// reordering (position swap with the neighbor), and playlist deletion.
// Ownership is `playlist.ownerUserId === user.id`; the backend enforces
// the same boundary (non-owners get 404), so hidden controls can never be
// reached by URL either.

import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import type { PlaylistDetail, PlaylistItem, PlaylistVisibility } from '../api';
import {
  apiErrorMessage,
  deletePlaylist,
  getPlaylist,
  movePlaylistItem,
  removePlaylistItem,
  updatePlaylist,
} from '../api';
import { useAuth } from '../auth';
import { useQueueActions } from '../player';
import { useOffline } from '../offline/OfflineProvider';
import { DownloadButton } from '../offline/components/DownloadButton';
import { ArtworkImage, formatDuration, formatTrackCount } from '../catalog';
import { Button, ErrorState, LoadingState, Screen } from '../components';
import { LikeButton, PlaylistForm, type PlaylistFormValues } from '../library';
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

function sortItems(items: PlaylistItem[]): PlaylistItem[] {
  return items
    .slice()
    .sort((a, b) => a.position - b.position || a.addedAt.localeCompare(b.addedAt));
}

export function PlaylistDetailScreen({ playlistId }: { playlistId: string }) {
  const { api, user } = useAuth();
  const router = useRouter();
  const { playTracks, addToQueue } = useQueueActions();
  // Phase 25 — playlist bulk download + per-track download buttons.
  const offline = useOffline();
  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [mutating, setMutating] = useState(false);
  const [formVisible, setFormVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlaylist(await getPlaylist(api, playlistId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [api, playlistId]);

  // Reload when the screen regains focus so tracks added via the picker
  // screen show up immediately on back navigation.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const isOwner = Boolean(user && playlist && playlist.ownerUserId === user.id);
  const sorted = playlist ? sortItems(playlist.items) : [];

  const playFrom = useCallback(
    (index: number) => {
      const tracks = sortItems(playlist?.items ?? []).map((item) => item.track);
      return playTracks(tracks, index);
    },
    [playTracks, playlist],
  );

  const saveEdits = useCallback(
    async (values: PlaylistFormValues) => {
      setSaving(true);
      setFormError(null);
      try {
        const updated = await updatePlaylist(api, playlistId, {
          title: values.title,
          description: values.description,
          visibility: values.visibility,
        });
        setPlaylist(updated);
        setFormVisible(false);
      } catch (err) {
        setFormError(apiErrorMessage(err));
      } finally {
        setSaving(false);
      }
    },
    [api, playlistId],
  );

  const confirmDelete = useCallback(() => {
    if (!playlist) {
      return;
    }
    Alert.alert(
      'Delete playlist?',
      `"${playlist.title}" will be removed from your library. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setMutating(true);
            deletePlaylist(api, playlistId)
              .then(() => router.back())
              .catch((err: unknown) => {
                Alert.alert('Could not delete playlist', apiErrorMessage(err));
                setMutating(false);
              });
          },
        },
      ],
    );
  }, [api, playlist, playlistId, router]);

  const removeItem = useCallback(
    async (item: PlaylistItem) => {
      if (mutating) {
        return;
      }
      setMutating(true);
      try {
        await removePlaylistItem(api, playlistId, item.id);
        await load();
      } catch (err) {
        Alert.alert('Could not remove track', apiErrorMessage(err));
      } finally {
        setMutating(false);
      }
    },
    [api, load, mutating, playlistId],
  );

  const moveItem = useCallback(
    async (index: number, direction: -1 | 1) => {
      const target = index + direction;
      if (mutating || target < 0 || target >= sorted.length) {
        return;
      }
      setMutating(true);
      try {
        const current = sorted[index];
        const other = sorted[target];
        // Swap absolute positions so the ordering stays stable without
        // renumbering the whole list.
        await movePlaylistItem(api, playlistId, current.id, other.position);
        await movePlaylistItem(api, playlistId, other.id, current.position);
        await load();
      } catch (err) {
        Alert.alert('Could not reorder track', apiErrorMessage(err));
      } finally {
        setMutating(false);
      }
    },
    [api, load, mutating, playlistId, sorted],
  );

  if (loading) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="playlist-detail-screen">
        <LoadingState message="Loading playlist…" />
      </Screen>
    );
  }

  if (error || !playlist) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="playlist-detail-screen">
        <ErrorState message={apiErrorMessage(error)} onRetry={load} />
      </Screen>
    );
  }

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="playlist-detail-screen">
      <Stack.Screen options={{ title: playlist.title }} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <ArtworkImage uri={playlist.coverArtUrl} title={playlist.title} seed={playlist.id} size={160} />
          <Text style={styles.title}>{playlist.title}</Text>
          {playlist.description ? (
            <Text style={styles.description}>{playlist.description}</Text>
          ) : null}
          <Text style={styles.meta}>
            By {playlist.ownerDisplayName} • {formatTrackCount(playlist.trackCount)}
          </Text>
          {isOwner ? (
            <View style={styles.visibilityBadge} testID="playlist-visibility-badge">
              <Ionicons
                name={playlist.visibility === 'PRIVATE' ? 'lock-closed' : 'globe'}
                size={fontSize.xs}
                color={colors.textMuted}
              />
              <Text style={styles.visibilityText}>{visibilityLabel(playlist.visibility)}</Text>
            </View>
          ) : null}
        </View>

        {sorted.length > 0 ? (
          <View style={styles.playAllWrap}>
            <Button
              title="Play"
              onPress={() => void playFrom(0)}
              testID="playlist-play-all"
            />
            <Button
              title="Download"
              variant="secondary"
              onPress={() => void offline.downloadTracks(sorted.map((item) => item.track))}
              testID="playlist-download-all"
            />
          </View>
        ) : null}

        {isOwner ? (
          <View style={styles.ownerActions}>
            <Pressable
              onPress={() => setFormVisible(true)}
              accessibilityRole="button"
              accessibilityLabel="Edit playlist"
              style={({ pressed }) => [styles.ownerButton, pressed && styles.pressed]}
              testID="playlist-edit-button"
            >
              <Ionicons name="pencil" size={fontSize.md} color={colors.text} />
              <Text style={styles.ownerButtonText}>Edit</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push(`/add-tracks/${playlistId}`)}
              accessibilityRole="button"
              accessibilityLabel="Add tracks to playlist"
              style={({ pressed }) => [styles.ownerButton, pressed && styles.pressed]}
              testID="playlist-add-tracks-button"
            >
              <Ionicons name="add" size={fontSize.md} color={colors.text} />
              <Text style={styles.ownerButtonText}>Add tracks</Text>
            </Pressable>
            <Pressable
              onPress={confirmDelete}
              disabled={mutating}
              accessibilityRole="button"
              accessibilityLabel="Delete playlist"
              style={({ pressed }) => [styles.ownerButton, pressed && styles.pressed]}
              testID="playlist-delete-button"
            >
              <Ionicons name="trash" size={fontSize.md} color={colors.error} />
              <Text style={[styles.ownerButtonText, styles.deleteText]}>Delete</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.tracks}>
          {sorted.length === 0 ? (
            <Text style={styles.emptyTracks} testID="playlist-empty-tracks">
              {isOwner
                ? 'This playlist is empty. Add some tracks to get started.'
                : 'This playlist has no tracks yet.'}
            </Text>
          ) : (
            sorted.map((item, i) => (
              <View key={item.id} style={styles.trackRowWrap}>
                <Pressable
                  onPress={() => void playFrom(i)}
                  onLongPress={() => void addToQueue(item.track)}
                  accessibilityRole="button"
                  accessibilityLabel={`Play ${item.track.title} by ${item.track.artistName}`}
                  style={({ pressed }) => [styles.trackPressable, pressed && styles.pressed]}
                  testID={`playlist-track-${item.id}`}
                >
                  <Text style={styles.index}>{i + 1}</Text>
                  <ArtworkImage
                    uri={null}
                    title={item.track.albumTitle ?? item.track.title}
                    seed={item.track.albumId ?? item.track.id}
                    size={48}
                  />
                  <View style={styles.texts}>
                    <Text style={styles.trackTitle} numberOfLines={1}>
                      {item.track.title}
                    </Text>
                    <Text style={styles.trackSubtitle} numberOfLines={1}>
                      {item.track.artistName}
                    </Text>
                  </View>
                  <Text style={styles.metaText}>{formatDuration(item.track.durationMs)}</Text>
                </Pressable>
                <LikeButton trackId={item.track.id} />
                <DownloadButton track={item.track} />
                {isOwner ? (
                  <View style={styles.manageButtons}>
                    <Pressable
                      onPress={() => void moveItem(i, -1)}
                      disabled={mutating || i === 0}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Move ${item.track.title} up`}
                      style={({ pressed }) => [styles.manageButton, pressed && styles.pressed]}
                      testID={`playlist-item-up-${item.id}`}
                    >
                      <Ionicons
                        name="chevron-up"
                        size={fontSize.md}
                        color={i === 0 ? colors.textFaint : colors.textMuted}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => void moveItem(i, 1)}
                      disabled={mutating || i === sorted.length - 1}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Move ${item.track.title} down`}
                      style={({ pressed }) => [styles.manageButton, pressed && styles.pressed]}
                      testID={`playlist-item-down-${item.id}`}
                    >
                      <Ionicons
                        name="chevron-down"
                        size={fontSize.md}
                        color={i === sorted.length - 1 ? colors.textFaint : colors.textMuted}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => void removeItem(item)}
                      disabled={mutating}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${item.track.title} from playlist`}
                      style={({ pressed }) => [styles.manageButton, pressed && styles.pressed]}
                      testID={`playlist-item-remove-${item.id}`}
                    >
                      <Ionicons name="close" size={fontSize.md} color={colors.textMuted} />
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {isOwner ? (
        <PlaylistForm
          visible={formVisible}
          mode="edit"
          initial={{
            title: playlist.title,
            description: playlist.description,
            visibility: playlist.visibility,
          }}
          saving={saving}
          error={formError}
          onSubmit={(input) => void saveEdits(input)}
          onClose={() => {
            if (!saving) {
              setFormVisible(false);
            }
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl },
  header: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  description: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.6,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  meta: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
  visibilityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
  },
  visibilityText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  playAllWrap: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    flexDirection: 'row',
    gap: spacing.sm,
  },
  ownerActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.lg,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  ownerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
  },
  ownerButtonText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  deleteText: { color: colors.error },
  pressed: { opacity: 0.6 },
  tracks: { marginTop: spacing.md },
  emptyTracks: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  trackRowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.sm,
  },
  trackPressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    minWidth: 0,
  },
  index: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    width: 24,
    textAlign: 'center',
  },
  texts: { flex: 1, minWidth: 0 },
  trackTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },
  trackSubtitle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  metaText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontVariant: ['tabular-nums'],
  },
  manageButtons: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  manageButton: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
