// Phase 6 — public playlist detail: cover header plus the embedded track
// items (the detail response carries all items; no pagination needed).

import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { PlaylistDetail } from '../api';
import { apiErrorMessage, getPlaylist } from '../api';
import { useAuth } from '../auth';
import { ArtworkImage, TrackRow, formatTrackCount } from '../catalog';
import { ErrorState, LoadingState, Screen } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

export function PlaylistDetailScreen({ playlistId }: { playlistId: string }) {
  const { api } = useAuth();
  const router = useRouter();
  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

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

  useEffect(() => {
    load();
  }, [load]);

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

  const sorted = playlist.items.slice().sort((a, b) => a.position - b.position);

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="playlist-detail-screen">
      <Stack.Screen options={{ title: playlist.title }} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <ArtworkImage
            uri={playlist.coverArtUrl}
            title={playlist.title}
            seed={playlist.id}
            size={160}
          />
          <Text style={styles.title}>{playlist.title}</Text>
          {playlist.description ? (
            <Text style={styles.description}>{playlist.description}</Text>
          ) : null}
          <Text style={styles.meta}>
            By {playlist.ownerDisplayName} • {formatTrackCount(playlist.trackCount)}
          </Text>
        </View>

        <View style={styles.tracks}>
          {sorted.map((item, i) => (
            <TrackRow
              key={item.id}
              track={item.track}
              index={i + 1}
              onPress={() =>
                router.push(
                  item.track.albumId
                    ? `/album/${item.track.albumId}`
                    : `/artist/${item.track.artistId}`,
                )
              }
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
  tracks: { marginTop: spacing.md },
});
