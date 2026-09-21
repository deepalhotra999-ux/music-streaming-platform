// Phase 6 — album detail: cover header, artist link, and the full track
// listing (embedded in the album detail response — no extra round trip).

import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { AlbumDetail, TrackStatus, TrackSummary } from '../api';
import { apiErrorMessage, getAlbum } from '../api';
import { useAuth } from '../auth';
import { useQueueActions } from '../player';
import {
  AlbumTrackRow,
  ArtworkImage,
  formatReleaseYear,
  formatTotalDuration,
  formatTrackCount,
} from '../catalog';
import { ErrorState, LoadingState, Screen } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

const ALBUM_TYPE_LABELS: Record<string, string> = {
  ALBUM: 'Album',
  SINGLE: 'Single',
  EP: 'EP',
  COMPILATION: 'Compilation',
};

export function AlbumDetailScreen({ albumId }: { albumId: string }) {
  const { api } = useAuth();
  const router = useRouter();
  // Phase 9 — tapping a track plays the album from that track; long-press
  // appends the track to the current queue.
  const { playTracks, addToQueue } = useQueueActions();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAlbum(await getAlbum(api, albumId));
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [api, albumId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="album-detail-screen">
        <LoadingState message="Loading album…" />
      </Screen>
    );
  }

  if (error || !album) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="album-detail-screen">
        <ErrorState message={apiErrorMessage(error)} onRetry={load} />
      </Screen>
    );
  }

  const year = formatReleaseYear(album.releaseDate);
  const totalMs = album.tracks.reduce((sum, t) => sum + t.durationMs, 0);
  // Album-embedded tracks carry no artist/album summaries, so synthesize
  // TrackSummary records from the album context for the queue.
  const sorted = album.tracks
    .slice()
    .sort((a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0));
  const summaries: TrackSummary[] = sorted.map((track) => ({
    id: track.id,
    title: track.title,
    durationMs: track.durationMs,
    status: track.status as TrackStatus,
    artistId: album.artistId,
    artistName: album.artistName,
    albumId: album.id,
    albumTitle: album.title,
  }));

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="album-detail-screen">
      <Stack.Screen options={{ title: album.title }} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <ArtworkImage
            uri={album.coverArtUrl}
            title={album.title}
            seed={album.id}
            size={192}
          />
          <Text style={styles.title}>{album.title}</Text>
          <Text style={styles.artist} onPress={() => router.push(`/artist/${album.artistId}`)}>
            {album.artistName}
          </Text>
          <Text style={styles.meta}>
            {ALBUM_TYPE_LABELS[album.albumType] ?? album.albumType}
            {year ? ` • ${year}` : ''} • {formatTrackCount(album.trackCount)}
            {totalMs > 0 ? ` • ${formatTotalDuration(totalMs)}` : ''}
          </Text>
        </View>

        <View style={styles.tracks}>
          {sorted.map((track, i) => (
            <AlbumTrackRow
              key={track.id}
              track={track}
              artistName={album.artistName}
              index={track.trackNumber ?? i + 1}
              onPress={() => void playTracks(summaries, i)}
              onLongPress={() => void addToQueue(summaries[i])}
            />
          ))}
        </View>
      </ScrollView>
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
  artist: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
    marginTop: spacing.xs,
  },
  meta: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  tracks: { marginTop: spacing.md },
});
