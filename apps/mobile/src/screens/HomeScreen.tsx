// Phase 6 — Home: catalog browse sections.
//
// Five rails backed by the real Phase 4 catalog API, fetched in parallel:
// new releases, artists, recently added tracks, featured playlists, and
// genres. Each rail owns its loading/error/empty state so one failing
// endpoint never takes down the whole screen.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import type {
  AlbumListItem,
  ApiClient,
  ArtistListItem,
  Genre,
  PlaylistListItem,
  TrackListItem,
} from '../api';
import {
  apiErrorMessage,
  listAlbums,
  listArtists,
  listGenres,
  listPublicPlaylists,
  listTracks,
} from '../api';
import { useAuth } from '../auth';
import {
  AlbumCard,
  ArtistCard,
  GenreCard,
  PlaylistCard,
  SectionHeader,
  TrackRow,
} from '../catalog';
import { Screen } from '../components';
import { colors, fontSize, spacing } from '../theme';

interface Rail<T> {
  items: T[];
  loading: boolean;
  error: unknown;
}

interface HomeRails {
  albums: Rail<AlbumListItem>;
  artists: Rail<ArtistListItem>;
  tracks: Rail<TrackListItem>;
  playlists: Rail<PlaylistListItem>;
  genres: Rail<Genre>;
}

const emptyRail = <T,>(): Rail<T> => ({ items: [], loading: true, error: null });

async function loadRails(api: ApiClient): Promise<HomeRails> {
  const [albums, artists, tracks, playlists, genres] = await Promise.all([
    listAlbums(api, { limit: 10 }).then(
      (p) => ({ ok: true as const, items: p.data }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    listArtists(api, { limit: 10 }).then(
      (p) => ({ ok: true as const, items: p.data }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    listTracks(api, { limit: 5 }).then(
      (p) => ({ ok: true as const, items: p.data }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    listPublicPlaylists(api, { limit: 10 }).then(
      (p) => ({ ok: true as const, items: p.data }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    listGenres(api, { limit: 20 }).then(
      (p) => ({ ok: true as const, items: p.data }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  const toRail = <T,>(r: { ok: boolean; items?: T[]; error?: unknown }): Rail<T> => ({
    items: r.ok && r.items ? r.items : [],
    loading: false,
    error: r.ok ? null : (r.error ?? new Error('Failed to load')),
  });
  return {
    albums: toRail(albums),
    artists: toRail(artists),
    tracks: toRail(tracks),
    playlists: toRail(playlists),
    genres: toRail(genres),
  };
}

function RailBody<T>({
  rail,
  onRetry,
  renderItems,
  emptyMessage,
}: {
  rail: Rail<T>;
  onRetry: () => void;
  renderItems: (items: T[]) => React.ReactNode;
  emptyMessage: string;
}) {
  if (rail.loading) {
    return <ActivityIndicator color={colors.primary} style={styles.railState} />;
  }
  if (rail.error) {
    return (
      <Text style={styles.railError} onPress={onRetry}>
        {apiErrorMessage(rail.error)} Tap to retry.
      </Text>
    );
  }
  if (rail.items.length === 0) {
    return <Text style={styles.railEmpty}>{emptyMessage}</Text>;
  }
  return <>{renderItems(rail.items)}</>;
}

export function HomeScreen() {
  const { api } = useAuth();
  const router = useRouter();
  const [rails, setRails] = useState<HomeRails>({
    albums: emptyRail(),
    artists: emptyRail(),
    tracks: emptyRail(),
    playlists: emptyRail(),
    genres: emptyRail(),
  });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) {
        setRefreshing(true);
      }
      try {
        setRails(await loadRails(api));
      } finally {
        setRefreshing(false);
      }
    },
    [api],
  );

  useEffect(() => {
    load();
  }, [load]);

  const retry = () => load();

  return (
    <Screen scrollable={false} padded={false} testID="home-screen">
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.primary} />
        }
      >
        <Text style={styles.greeting}>Browse the catalog</Text>

        <View style={styles.section}>
          <SectionHeader title="New releases" onSeeAll={() => router.push('/albums')} />
          <RailBody
            rail={rails.albums}
            onRetry={retry}
            emptyMessage="No albums yet."
            renderItems={(albums) => (
              <FlatList
                horizontal
                data={albums}
                keyExtractor={(a) => a.id}
                renderItem={({ item }) => (
                  <AlbumCard album={item} onPress={() => router.push(`/album/${item.id}`)} />
                )}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.railContent}
              />
            )}
          />
        </View>

        <View style={styles.section}>
          <SectionHeader title="Artists" onSeeAll={() => router.push('/artists')} />
          <RailBody
            rail={rails.artists}
            onRetry={retry}
            emptyMessage="No artists yet."
            renderItems={(artists) => (
              <FlatList
                horizontal
                data={artists}
                keyExtractor={(a) => a.id}
                renderItem={({ item }) => (
                  <ArtistCard artist={item} onPress={() => router.push(`/artist/${item.id}`)} />
                )}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.railContent}
              />
            )}
          />
        </View>

        <View style={styles.section}>
          <SectionHeader title="Recently added tracks" onSeeAll={() => router.push('/tracks')} />
          <RailBody
            rail={rails.tracks}
            onRetry={retry}
            emptyMessage="No tracks yet."
            renderItems={(tracks) => (
              <View>
                {tracks.map((track) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    onPress={() =>
                      router.push(
                        track.albumId ? `/album/${track.albumId}` : `/artist/${track.artistId}`,
                      )
                    }
                  />
                ))}
              </View>
            )}
          />
        </View>

        <View style={styles.section}>
          <SectionHeader title="Featured playlists" onSeeAll={() => router.push('/playlists')} />
          <RailBody
            rail={rails.playlists}
            onRetry={retry}
            emptyMessage="No public playlists yet."
            renderItems={(playlists) => (
              <FlatList
                horizontal
                data={playlists}
                keyExtractor={(p) => p.id}
                renderItem={({ item }) => (
                  <PlaylistCard playlist={item} onPress={() => router.push(`/playlist/${item.id}`)} />
                )}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.railContent}
              />
            )}
          />
        </View>

        <View style={styles.section}>
          <SectionHeader title="Browse genres" onSeeAll={() => router.push('/genres')} />
          <RailBody
            rail={rails.genres}
            onRetry={retry}
            emptyMessage="No genres yet."
            renderItems={(genres) => (
              <FlatList
                horizontal
                data={genres}
                keyExtractor={(g) => g.id}
                renderItem={({ item }) => (
                  <GenreCard genre={item} onPress={() => router.push(`/genre/${item.id}`)} />
                )}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.railContent}
              />
            )}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  greeting: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  section: { marginBottom: spacing.xl },
  railContent: { paddingHorizontal: spacing.lg },
  railState: { paddingVertical: spacing.xl },
  railError: {
    color: colors.error,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  railEmpty: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
});
