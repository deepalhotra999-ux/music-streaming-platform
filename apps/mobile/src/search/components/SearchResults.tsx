// Phase 12 — categorized search results.
//
// One section per non-empty category with a result-type header. Rows reuse
// the Phase 6 catalog components; genre gets a small local row (the catalog
// kit only ships a GenreCard). Track rows play through the shared queue
// actions; every other row navigates to its existing detail screen.

import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Genre } from '../../api';
import {
  AlbumRow,
  ArtistRow,
  ArtworkImage,
  PlaylistRow,
  TrackRow,
} from '../../catalog';
import { formatTrackCount } from '../../catalog/format';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { CATEGORY_LABELS } from '../api';
import type { CategorizedResults, SearchCategory } from '../types';

export interface SearchResultHandlers {
  onArtistPress: (id: string) => void;
  onAlbumPress: (id: string) => void;
  onGenrePress: (id: string) => void;
  onPlaylistPress: (id: string) => void;
  onTrackPress: (index: number) => void;
  onTrackLongPress: (index: number) => void;
}

function Section({
  category,
  count,
  children,
  testID,
}: {
  category: SearchCategory;
  count: number;
  children: ReactNode;
  testID: string;
}) {
  return (
    <View style={styles.section} testID={testID}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{CATEGORY_LABELS[category]}</Text>
        <Text style={styles.sectionCount}>{count}</Text>
      </View>
      {children}
    </View>
  );
}

function GenreRow({ genre, onPress }: { genre: Genre; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Genre ${genre.name}`}
      testID={`genre-row-${genre.id}`}
      style={({ pressed }) => [styles.genreRow, pressed && styles.pressed]}
    >
      <ArtworkImage uri={null} title={genre.name} seed={genre.id} size={48} />
      <View style={styles.genreTexts}>
        <Text style={styles.genreName} numberOfLines={1}>
          {genre.name}
        </Text>
        <Text style={styles.genreCount} numberOfLines={1}>
          {formatTrackCount(genre.trackCount)}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={fontSize.md} color={colors.textFaint} />
    </Pressable>
  );
}

export function SearchResults({
  results,
  handlers,
  testID = 'search-results',
}: {
  results: CategorizedResults;
  handlers: SearchResultHandlers;
  testID?: string;
}) {
  return (
    <View testID={testID}>
      {results.artists.items.length > 0 ? (
        <Section category="artists" count={results.artists.total} testID={`${testID}-artists`}>
          {results.artists.items.map((artist) => (
            <ArtistRow
              key={artist.id}
              artist={artist}
              onPress={() => handlers.onArtistPress(artist.id)}
            />
          ))}
        </Section>
      ) : null}
      {results.albums.items.length > 0 ? (
        <Section category="albums" count={results.albums.total} testID={`${testID}-albums`}>
          {results.albums.items.map((album) => (
            <AlbumRow key={album.id} album={album} onPress={() => handlers.onAlbumPress(album.id)} />
          ))}
        </Section>
      ) : null}
      {results.tracks.items.length > 0 ? (
        <Section category="tracks" count={results.tracks.total} testID={`${testID}-tracks`}>
          {results.tracks.items.map((track, index) => (
            <TrackRow
              key={track.id}
              track={track}
              onPress={() => handlers.onTrackPress(index)}
              onLongPress={() => handlers.onTrackLongPress(index)}
            />
          ))}
        </Section>
      ) : null}
      {results.genres.items.length > 0 ? (
        <Section category="genres" count={results.genres.total} testID={`${testID}-genres`}>
          {results.genres.items.map((genre) => (
            <GenreRow key={genre.id} genre={genre} onPress={() => handlers.onGenrePress(genre.id)} />
          ))}
        </Section>
      ) : null}
      {results.playlists.items.length > 0 ? (
        <Section
          category="playlists"
          count={results.playlists.total}
          testID={`${testID}-playlists`}
        >
          {results.playlists.items.map((playlist) => (
            <PlaylistRow
              key={playlist.id}
              playlist={playlist}
              onPress={() => handlers.onPlaylistPress(playlist.id)}
            />
          ))}
        </Section>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.md },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  sectionCount: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
  },
  pressed: { opacity: 0.7 },
  genreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  genreTexts: { flex: 1, minWidth: 0 },
  genreName: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },
  genreCount: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
});
