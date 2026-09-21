// Phase 6 — vertical list rows (tracks, artists, albums, playlists).

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type {
  AlbumListItem,
  AlbumTrack,
  ArtistListItem,
  PlaylistListItem,
  TrackListItem,
  TrackSummary,
} from '../../api';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import {
  formatDuration,
  formatFollowerCount,
  formatReleaseYear,
  formatTrackCount,
} from '../format';
import { ArtworkImage } from './ArtworkImage';

function RowShell({
  onPress,
  onLongPress,
  label,
  testID,
  children,
}: {
  onPress?: () => void;
  onLongPress?: () => void;
  label: string;
  testID?: string;
  children: React.ReactNode;
}) {
  const interactive = Boolean(onPress || onLongPress);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!interactive}
      accessibilityRole={interactive ? 'button' : undefined}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && interactive && styles.pressed]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

function RowTexts({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.texts}>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

export function TrackRow({
  track,
  onPress,
  onLongPress,
  index,
}: {
  track: TrackListItem | TrackSummary;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Optional 1-based position shown in album/playlist context. */
  index?: number;
}) {
  return (
    <RowShell
      onPress={onPress}
      onLongPress={onLongPress}
      label={`Track ${track.title} by ${track.artistName}`}
      testID={`track-row-${track.id}`}
    >
      {index !== undefined ? <Text style={styles.index}>{index}</Text> : null}
      <ArtworkImage
        uri={null}
        title={track.albumTitle ?? track.title}
        seed={track.albumId ?? track.id}
        size={48}
      />
      <RowTexts title={track.title} subtitle={track.artistName} />
      <Text style={styles.meta}>{formatDuration(track.durationMs)}</Text>
    </RowShell>
  );
}

/** Album-embedded track (no artist/album summary on the row). */
export function AlbumTrackRow({
  track,
  artistName,
  index,
  onPress,
  onLongPress,
}: {
  track: AlbumTrack;
  artistName: string;
  index: number;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  return (
    <RowShell
      onPress={onPress}
      onLongPress={onLongPress}
      label={`Track ${track.title} by ${artistName}`}
      testID={`album-track-row-${track.id}`}
    >
      <Text style={styles.index}>{index}</Text>
      <RowTexts title={track.title} subtitle={artistName} />
      <Text style={styles.meta}>{formatDuration(track.durationMs)}</Text>
    </RowShell>
  );
}

export function ArtistRow({ artist, onPress }: { artist: ArtistListItem; onPress: () => void }) {
  return (
    <RowShell onPress={onPress} label={`Artist ${artist.name}`} testID={`artist-row-${artist.id}`}>
      <ArtworkImage uri={null} title={artist.name} seed={artist.id} size={56} shape="circle" />
      <View style={styles.texts}>
        <View style={styles.nameRow}>
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
      </View>
      <Ionicons name="chevron-forward" size={fontSize.md} color={colors.textFaint} />
    </RowShell>
  );
}

export function AlbumRow({ album, onPress }: { album: AlbumListItem; onPress: () => void }) {
  const year = formatReleaseYear(album.releaseDate);
  const subtitle = year
    ? `${album.artistName} • ${year} • ${formatTrackCount(album.trackCount)}`
    : `${album.artistName} • ${formatTrackCount(album.trackCount)}`;
  return (
    <RowShell onPress={onPress} label={`Album ${album.title}`} testID={`album-row-${album.id}`}>
      <ArtworkImage uri={album.coverArtUrl} title={album.title} seed={album.id} size={56} />
      <RowTexts title={album.title} subtitle={subtitle} />
      <Ionicons name="chevron-forward" size={fontSize.md} color={colors.textFaint} />
    </RowShell>
  );
}

export function PlaylistRow({
  playlist,
  onPress,
}: {
  playlist: PlaylistListItem;
  onPress: () => void;
}) {
  return (
    <RowShell
      onPress={onPress}
      label={`Playlist ${playlist.title}`}
      testID={`playlist-row-${playlist.id}`}
    >
      <ArtworkImage uri={playlist.coverArtUrl} title={playlist.title} seed={playlist.id} size={56} />
      <RowTexts
        title={playlist.title}
        subtitle={`By ${playlist.ownerDisplayName} • ${formatTrackCount(playlist.trackCount)}`}
      />
      <Ionicons name="chevron-forward" size={fontSize.md} color={colors.textFaint} />
    </RowShell>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  pressed: { opacity: 0.7 },
  index: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    width: 24,
    textAlign: 'center',
  },
  texts: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
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
  meta: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontVariant: ['tabular-nums'],
  },
});
