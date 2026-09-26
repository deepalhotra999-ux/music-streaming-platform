// Phase 29 — artist post composer. Creates a post for one of the caller's
// own artists with an optional track or album attachment. Tracks that are
// not READY are shown disabled (the backend rejects them too); albums
// attach freely.

import { useCallback, useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import type { AlbumListItem, ArtistListItem, TrackListItem } from '../api';
import { apiErrorMessage, createPost, listAlbums, listMyArtists, listTracks } from '../api';
import { useAuth } from '../auth';
import { Button, EmptyState, ErrorState, LoadingState, Screen, TextInput } from '../components';
import { colors, spacing } from '../theme';

const MAX_BODY = 2000;

type PickerKind = 'track' | 'album' | null;

export function ComposePostScreen() {
  const { api } = useAuth();
  const router = useRouter();

  const [artists, setArtists] = useState<ArtistListItem[]>([]);
  const [loadingArtists, setLoadingArtists] = useState(true);
  const [artistsError, setArtistsError] = useState<unknown>(null);
  const [artistId, setArtistId] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [trackId, setTrackId] = useState<string | null>(null);
  const [albumId, setAlbumId] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerKind>(null);
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [albums, setAlbums] = useState<AlbumListItem[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadArtists = useCallback(async () => {
    setLoadingArtists(true);
    setArtistsError(null);
    try {
      const page = await listMyArtists(api);
      setArtists(page.data);
      if (page.data.length > 0) {
        setArtistId((current) => current ?? page.data[0]!.id);
      }
    } catch (err) {
      setArtistsError(err);
    } finally {
      setLoadingArtists(false);
    }
  }, [api]);

  useEffect(() => {
    void loadArtists();
  }, [loadArtists]);

  const openPicker = useCallback(
    async (kind: Exclude<PickerKind, null>) => {
      if (!artistId) {
        return;
      }
      setPicker(kind);
      setPickerLoading(true);
      try {
        if (kind === 'track') {
          const page = await listTracks(api, { artistId, limit: 100 });
          setTracks(page.data);
        } else {
          const page = await listAlbums(api, { artistId, limit: 100 });
          setAlbums(page.data);
        }
      } catch {
        if (kind === 'track') {
          setTracks([]);
        } else {
          setAlbums([]);
        }
      } finally {
        setPickerLoading(false);
      }
    },
    [api, artistId],
  );

  const selectedTrack = tracks.find((t) => t.id === trackId) ?? null;
  const selectedAlbum = albums.find((a) => a.id === albumId) ?? null;

  const canSubmit = artistId != null && body.trim().length > 0 && !saving;

  const submit = useCallback(async () => {
    if (!canSubmit || !artistId) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createPost(api, {
        artistId,
        body: body.trim(),
        trackId: trackId ?? undefined,
        albumId: albumId ?? undefined,
      });
      router.back();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [api, albumId, artistId, body, canSubmit, router, trackId]);

  if (loadingArtists) {
    return (
      <Screen edges={['bottom']} testID="compose-post-screen">
        <LoadingState message="Loading your artists…" />
      </Screen>
    );
  }

  if (artistsError) {
    return (
      <Screen edges={['bottom']} testID="compose-post-screen">
        <ErrorState message={apiErrorMessage(artistsError)} onRetry={loadArtists} />
      </Screen>
    );
  }

  if (artists.length === 0) {
    return (
      <Screen edges={['bottom']} testID="compose-post-screen">
        <EmptyState
          title="No artist profile"
          message="Create an artist profile to post to the community."
          actionTitle="Back"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  return (
    <Screen edges={['bottom']} testID="compose-post-screen">
      <Text style={styles.label}>Post as</Text>
      <View style={styles.artistRow}>
        {artists.map((artist) => (
          <Pressable
            key={artist.id}
            style={[styles.artistChip, artistId === artist.id && styles.artistChipActive]}
            onPress={() => {
              setArtistId(artist.id);
              setTrackId(null);
              setAlbumId(null);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: artistId === artist.id }}
            testID={`compose-artist-${artist.id}`}
          >
            <Text
              style={[styles.artistChipText, artistId === artist.id && styles.artistChipTextActive]}
              numberOfLines={1}
            >
              {artist.name}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>What&apos;s happening?</Text>
      <TextInput
        label="Post"
        value={body}
        onChangeText={setBody}
        placeholder="Share news, tour dates, studio notes…"
        multiline
        numberOfLines={6}
        maxLength={MAX_BODY}
        editable={!saving}
        testID="compose-post-body"
      />
      <Text style={styles.counter}>
        {body.length}/{MAX_BODY}
      </Text>

      <Text style={styles.label}>Attachment (optional)</Text>
      <View style={styles.attachRow}>
        <Pressable
          style={[styles.attachButton, trackId != null && styles.attachButtonActive]}
          onPress={() => void openPicker('track')}
          accessibilityRole="button"
          testID="compose-attach-track"
        >
          <Ionicons
            name="musical-note"
            size={18}
            color={trackId != null ? colors.onPrimary : colors.primary}
          />
          <Text style={[styles.attachButtonText, trackId != null && styles.attachButtonTextActive]}>
            {selectedTrack ? selectedTrack.title : 'Track'}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.attachButton, albumId != null && styles.attachButtonActive]}
          onPress={() => void openPicker('album')}
          accessibilityRole="button"
          testID="compose-attach-album"
        >
          <Ionicons
            name="disc"
            size={18}
            color={albumId != null ? colors.onPrimary : colors.primary}
          />
          <Text style={[styles.attachButtonText, albumId != null && styles.attachButtonTextActive]}>
            {selectedAlbum ? selectedAlbum.title : 'Album'}
          </Text>
        </Pressable>
        {trackId != null || albumId != null ? (
          <Pressable
            onPress={() => {
              setTrackId(null);
              setAlbumId(null);
            }}
            accessibilityRole="button"
            accessibilityLabel="Remove attachment"
            hitSlop={12}
            testID="compose-attach-clear"
          >
            <Ionicons name="close-circle" size={24} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <Button
          title="Cancel"
          variant="secondary"
          onPress={() => router.back()}
          disabled={saving}
        />
        <Button
          title={saving ? 'Publishing…' : 'Publish'}
          onPress={submit}
          disabled={!canSubmit}
          testID="compose-post-submit"
        />
      </View>

      <Modal
        visible={picker != null}
        transparent
        animationType="slide"
        onRequestClose={() => setPicker(null)}
      >
        <View style={styles.pickerBackdrop}>
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>
                {picker === 'track' ? 'Attach a track' : 'Attach an album'}
              </Text>
              <Pressable
                onPress={() => setPicker(null)}
                accessibilityRole="button"
                accessibilityLabel="Close picker"
                hitSlop={12}
              >
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            {pickerLoading ? (
              <LoadingState message="Loading…" />
            ) : picker === 'track' ? (
              <FlatList
                data={tracks}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => {
                  const ready = item.audioStatus === 'READY';
                  return (
                    <Pressable
                      style={styles.pickerRow}
                      onPress={() => {
                        setTrackId(item.id);
                        setAlbumId(null);
                        setPicker(null);
                      }}
                      disabled={!ready}
                      accessibilityRole="button"
                      accessibilityLabel={item.title}
                      testID={`picker-track-${item.id}`}
                    >
                      <Ionicons
                        name="musical-note"
                        size={18}
                        color={ready ? colors.primary : colors.textFaint}
                      />
                      <View style={styles.pickerRowText}>
                        <Text
                          style={[styles.pickerRowTitle, !ready && styles.pickerRowDisabled]}
                          numberOfLines={1}
                        >
                          {item.title}
                        </Text>
                        <Text style={styles.pickerRowSub}>
                          {ready
                            ? 'Ready to play'
                            : `Audio ${item.audioStatus.toLowerCase()} — not attachable`}
                        </Text>
                      </View>
                      {trackId === item.id ? (
                        <Ionicons name="checkmark" size={20} color={colors.primary} />
                      ) : null}
                    </Pressable>
                  );
                }}
                ListEmptyComponent={<EmptyState title="No tracks" message="Upload tracks first." />}
              />
            ) : (
              <FlatList
                data={albums}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <Pressable
                    style={styles.pickerRow}
                    onPress={() => {
                      setAlbumId(item.id);
                      setTrackId(null);
                      setPicker(null);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={item.title}
                    testID={`picker-album-${item.id}`}
                  >
                    <Ionicons name="disc" size={18} color={colors.primary} />
                    <View style={styles.pickerRowText}>
                      <Text style={styles.pickerRowTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={styles.pickerRowSub}>
                        {item.trackCount} {item.trackCount === 1 ? 'track' : 'tracks'}
                      </Text>
                    </View>
                    {albumId === item.id ? (
                      <Ionicons name="checkmark" size={20} color={colors.primary} />
                    ) : null}
                  </Pressable>
                )}
                ListEmptyComponent={
                  <EmptyState title="No albums" message="Create an album first." />
                }
              />
            )}
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: spacing.sm,
    marginTop: spacing.md,
    textTransform: 'uppercase',
  },
  artistRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  artistChip: {
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    maxWidth: '48%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  artistChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  artistChipText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  artistChipTextActive: {
    color: colors.onPrimary,
  },
  counter: {
    alignSelf: 'flex-end',
    color: colors.textFaint,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  attachRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  attachButton: {
    alignItems: 'center',
    borderColor: colors.primary,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  attachButtonActive: {
    backgroundColor: colors.primary,
  },
  attachButtonText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: '600',
    maxWidth: 140,
  },
  attachButtonTextActive: {
    color: colors.onPrimary,
  },
  error: {
    color: colors.error,
    fontSize: 13,
    marginTop: spacing.md,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    marginTop: spacing.lg,
  },
  pickerBackdrop: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%',
    padding: spacing.md,
  },
  pickerHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  pickerTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  pickerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingVertical: spacing.sm,
  },
  pickerRowText: {
    flex: 1,
    marginHorizontal: spacing.sm,
  },
  pickerRowTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  pickerRowDisabled: {
    color: colors.textFaint,
  },
  pickerRowSub: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
});
