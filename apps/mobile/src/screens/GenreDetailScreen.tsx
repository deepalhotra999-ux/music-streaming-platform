// Phase 6 — genre detail: genre header plus its paginated track list.
// Reuses TrackListScreen with a genre filter and a header component.

import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { apiErrorMessage, getGenre } from '../api';
import type { Genre } from '../api';
import { useAuth } from '../auth';
import { useCatalogDetail } from '../catalog';
import { ErrorState, LoadingState, Screen } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';
import { TrackListScreen } from './TrackListScreen';
import { formatTrackCount } from '../catalog';

export function GenreDetailScreen({ genreId }: { genreId: string }) {
  const { api } = useAuth();
  const genre = useCatalogDetail<Genre>(() => getGenre(api, genreId), [api, genreId]);

  if (genre.loading) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="genre-detail-screen">
        <LoadingState message="Loading genre…" />
      </Screen>
    );
  }

  if (genre.error || !genre.data) {
    return (
      <Screen scrollable={false} padded={false} edges={['bottom']} testID="genre-detail-screen">
        <ErrorState message={apiErrorMessage(genre.error)} onRetry={genre.retry} />
      </Screen>
    );
  }

  const g = genre.data;

  return (
    <>
      <Stack.Screen options={{ title: g.name }} />
      <TrackListScreen
        genreId={g.id}
        testID="genre-detail-screen"
        listHeader={
          <View style={styles.header}>
            <Text style={styles.name}>{g.name}</Text>
            {g.description ? <Text style={styles.description}>{g.description}</Text> : null}
            <Text style={styles.count}>{formatTrackCount(g.trackCount)}</Text>
          </View>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  name: {
    color: colors.text,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
  },
  description: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.6,
    marginTop: spacing.sm,
  },
  count: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
});
