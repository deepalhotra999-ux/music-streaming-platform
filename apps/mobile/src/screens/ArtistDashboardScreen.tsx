// Phase 13 — Artist dashboard (ARTIST-only tab).
//
// The artist's home: profile summary, catalog counts, published albums
// and tracks with draft/published status badges, and entry points to
// profile and catalog management. Artists with no artist row yet get a
// create CTA; every section carries its own empty/loading/error state.

import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import {
  apiErrorMessage,
  createArtist,
  getArtist,
  listAlbums,
  listMyArtists,
  listTracks,
  type AlbumListItem,
  type ArtistDetail,
  type ArtistListItem,
  type TrackListItem,
} from '../api';
import { useAuth } from '../auth';
import { AlbumCard, ArtworkImage, SectionHeader, TrackRow } from '../catalog';
import { StatusBadge } from '../artist';
import { Button, EmptyState, ErrorState, LoadingState, Screen, TextInput } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

type LoadState = 'loading' | 'ready' | 'error';

export function ArtistDashboardScreen() {
  const { api } = useAuth();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [artists, setArtists] = useState<ArtistListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ArtistDetail | null>(null);
  const [albums, setAlbums] = useState<AlbumListItem[]>([]);
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (artistId: string | null) => {
      setLoadState('loading');
      setError(null);
      try {
        const mine = await listMyArtists(api);
        setArtists(mine.data);
        const activeId = artistId ?? mine.data[0]?.id ?? null;
        setSelectedId(activeId);
        if (!activeId) {
          setDetail(null);
          setAlbums([]);
          setTracks([]);
          setLoadState('ready');
          return;
        }
        const [artistDetail, albumPage, trackPage] = await Promise.all([
          getArtist(api, activeId),
          listAlbums(api, { artistId: activeId, limit: 10 }),
          listTracks(api, { artistId: activeId, limit: 10 }),
        ]);
        setDetail(artistDetail);
        setAlbums(albumPage.data);
        setTracks(trackPage.data);
        setLoadState('ready');
      } catch (e) {
        setError(apiErrorMessage(e));
        setLoadState('error');
      }
    },
    [api],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const handleCreateArtist = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      setCreateError('Give your artist profile a name.');
      return;
    }
    setCreateError(null);
    setSaving(true);
    try {
      const created = await createArtist(api, { name });
      setNewName('');
      setCreating(false);
      await load(created.id);
    } catch (e) {
      setCreateError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [api, load, newName]);

  if (loadState === 'loading') {
    return (
      <Screen testID="artist-dashboard-screen">
        <LoadingState message="Loading your artist profile…" />
      </Screen>
    );
  }

  if (loadState === 'error') {
    return (
      <Screen testID="artist-dashboard-screen">
        <ErrorState message={error ?? 'Something went wrong.'} onRetry={() => load(selectedId)} />
      </Screen>
    );
  }

  if (artists.length === 0) {
    return (
      <Screen testID="artist-dashboard-screen">
        <EmptyState
          title="No artist profile yet"
          message="Create your artist profile to start managing your music."
        />
        {creating ? (
          <View style={styles.createForm} testID="create-artist-form">
            <TextInput
              label="Artist name"
              value={newName}
              onChangeText={setNewName}
              placeholder="Your artist name"
              autoCapitalize="words"
              testID="create-artist-name"
            />
            {createError ? <Text style={styles.formError}>{createError}</Text> : null}
            <View style={styles.formActions}>
              <Button title="Cancel" variant="secondary" onPress={() => setCreating(false)} />
              <Button
                title={saving ? 'Creating…' : 'Create profile'}
                onPress={handleCreateArtist}
                disabled={saving}
                testID="create-artist-submit"
              />
            </View>
          </View>
        ) : (
          <View style={styles.createCta}>
            <Button title="Create artist profile" onPress={() => setCreating(true)} />
          </View>
        )}
      </Screen>
    );
  }

  return (
    <Screen testID="artist-dashboard-screen" scrollable={false}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {artists.length > 1 ? (
          <View style={styles.switcher} testID="artist-switcher">
            {artists.map((a) => (
              <Button
                key={a.id}
                title={a.name}
                variant={a.id === selectedId ? 'primary' : 'secondary'}
                size="md"
                onPress={() => load(a.id)}
                testID={`artist-switch-${a.id}`}
              />
            ))}
          </View>
        ) : null}

        {detail ? (
          <View style={styles.profileCard} testID="artist-profile-summary">
            <ArtworkImage
              uri={detail.profile?.imageUrl ?? null}
              title={detail.name}
              seed={detail.id}
              size={72}
              shape="circle"
            />
            <View style={styles.profileText}>
              <Text style={styles.artistName}>
                {detail.name}
                {detail.verified ? ' ✓' : ''}
              </Text>
              {detail.profile?.bio ? (
                <Text style={styles.bio} numberOfLines={2}>
                  {detail.profile.bio}
                </Text>
              ) : null}
              <Text style={styles.counts} testID="artist-counts">
                {detail.counts.albums} {detail.counts.albums === 1 ? 'album' : 'albums'} ·{' '}
                {detail.counts.tracks} {detail.counts.tracks === 1 ? 'track' : 'tracks'} ·{' '}
                {detail.counts.followers}{' '}
                {detail.counts.followers === 1 ? 'follower' : 'followers'}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button
            title="View analytics"
            variant="secondary"
            onPress={() =>
              router.push({
                pathname: '/(artist)/analytics',
                params: selectedId ? { artistId: selectedId } : {},
              })
            }
            testID="view-analytics-button"
          />
          <Button
            title="View royalties"
            variant="secondary"
            onPress={() =>
              router.push({
                pathname: '/(artist)/royalties',
                params: selectedId ? { artistId: selectedId } : {},
              })
            }
            testID="view-royalties-button"
          />
          <Button
            title="Edit profile"
            variant="secondary"
            onPress={() => router.push('/(artist)/profile')}
            testID="manage-profile-button"
          />
        </View>

        <SectionHeader
          title="Albums"
          onSeeAll={() => router.push('/(artist)/albums')}
          testID="albums-section"
        />
        {albums.length === 0 ? (
          <Text style={styles.emptyNote}>No albums yet. Add your first release.</Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.rail}>
            {albums.map((album) => (
              <View key={album.id} style={styles.cardWrap}>
                <AlbumCard album={album} onPress={() => router.push('/(artist)/albums')} />
              </View>
            ))}
          </ScrollView>
        )}

        <SectionHeader
          title="Tracks"
          onSeeAll={() => router.push('/(artist)/tracks')}
          testID="tracks-section"
        />
        {tracks.length === 0 ? (
          <Text style={styles.emptyNote}>No tracks yet. Upload your first track.</Text>
        ) : (
          <View testID="dashboard-tracks">
            {tracks.map((track) => (
              <View key={track.id} style={styles.trackWrap}>
                <View style={styles.trackRow}>
                  <TrackRow track={track} onPress={() => router.push('/(artist)/tracks')} />
                </View>
                <StatusBadge status={track.status} />
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  switcher: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  profileText: {
    flex: 1,
    marginLeft: spacing.md,
  },
  artistName: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  bio: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  },
  counts: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  rail: {
    marginBottom: spacing.md,
  },
  cardWrap: {
    marginRight: spacing.md,
    width: 140,
  },
  emptyNote: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  trackWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: spacing.sm,
  },
  trackRow: {
    flex: 1,
  },
  createCta: {
    marginTop: spacing.md,
  },
  createForm: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  formActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  formError: {
    color: colors.error,
    fontSize: fontSize.sm,
  },
});
