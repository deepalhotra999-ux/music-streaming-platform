// Phase 6 — horizontal browse cards (albums, artists, playlists, genres).

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AlbumListItem, ArtistListItem, Genre, PlaylistListItem } from '../../api';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { formatFollowerCount, formatReleaseYear, formatTrackCount } from '../format';
import { ArtworkImage } from './ArtworkImage';

const CARD_WIDTH = 128;

function usePressedStyle(pressed: boolean) {
  return pressed ? styles.pressed : undefined;
}

export function AlbumCard({
  album,
  onPress,
}: {
  album: AlbumListItem;
  onPress: () => void;
}) {
  const year = formatReleaseYear(album.releaseDate);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Album ${album.title} by ${album.artistName}`}
      style={({ pressed }) => [styles.card, usePressedStyle(pressed)]}
      testID={`album-card-${album.id}`}
    >
      <ArtworkImage uri={album.coverArtUrl} title={album.title} seed={album.id} size={CARD_WIDTH} />
      <Text style={styles.title} numberOfLines={1}>
        {album.title}
      </Text>
      <Text style={styles.subtitle} numberOfLines={1}>
        {year ? `${album.artistName} • ${year}` : album.artistName}
      </Text>
    </Pressable>
  );
}

export function ArtistCard({
  artist,
  onPress,
}: {
  artist: ArtistListItem;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Artist ${artist.name}`}
      style={({ pressed }) => [styles.card, styles.artistCard, usePressedStyle(pressed)]}
      testID={`artist-card-${artist.id}`}
    >
      <ArtworkImage uri={null} title={artist.name} seed={artist.id} size={96} shape="circle" />
      <View style={styles.artistNameRow}>
        <Text style={styles.title} numberOfLines={1}>
          {artist.name}
        </Text>
        {artist.verified ? (
          <Ionicons name="checkmark-circle" size={fontSize.sm} color={colors.primary} />
        ) : null}
      </View>
      <Text style={styles.subtitle} numberOfLines={1}>
        {formatFollowerCount(artist.followerCount)}
      </Text>
    </Pressable>
  );
}

export function PlaylistCard({
  playlist,
  onPress,
}: {
  playlist: PlaylistListItem;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Playlist ${playlist.title}`}
      style={({ pressed }) => [styles.card, styles.playlistCard, usePressedStyle(pressed)]}
      testID={`playlist-card-${playlist.id}`}
    >
      <ArtworkImage
        uri={playlist.coverArtUrl}
        title={playlist.title}
        seed={playlist.id}
        size={140}
      />
      <Text style={styles.title} numberOfLines={1}>
        {playlist.title}
      </Text>
      <Text style={styles.subtitle} numberOfLines={1}>
        {formatTrackCount(playlist.trackCount)}
      </Text>
    </Pressable>
  );
}

export function GenreCard({
  genre,
  onPress,
  layout = 'rail',
}: {
  genre: Genre;
  onPress: () => void;
  /** 'rail' for horizontal scrolling; 'grid' stretches to fill a grid cell. */
  layout?: 'rail' | 'grid';
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Genre ${genre.name}`}
      style={({ pressed }) => [styles.genreCard, layout === 'grid' && styles.genreCardGrid, usePressedStyle(pressed)]}
      testID={`genre-card-${genre.id}`}
    >
      <Text style={styles.genreName} numberOfLines={1}>
        {genre.name}
      </Text>
      <Text style={styles.genreCount} numberOfLines={1}>
        {formatTrackCount(genre.trackCount)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { width: CARD_WIDTH, marginRight: spacing.md },
  artistCard: { width: 104, alignItems: 'center' },
  playlistCard: { width: 140 },
  pressed: { opacity: 0.7 },
  title: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.sm,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  artistNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    maxWidth: 104,
    marginTop: spacing.sm,
  },
  genreCard: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 16,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginRight: spacing.sm,
    minWidth: 120,
    borderWidth: 1,
    borderColor: colors.border,
  },
  genreCardGrid: {
    marginRight: 0,
    minWidth: 0,
    flex: 1,
  },
  genreName: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  genreCount: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
});
