// Phase 6 — genre list: two-column grid of genre cards.

import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { listGenres } from '../api';
import { useAuth } from '../auth';
import { CatalogListScreen, GenreCard } from '../catalog';
import { spacing } from '../theme';

export function GenreListScreen() {
  const { api } = useAuth();
  const router = useRouter();

  return (
    <CatalogListScreen
      fetchPage={(page) => listGenres(api, { page, limit: 20 })}
      keyExtractor={(genre) => genre.id}
      renderItem={(genre) => (
        <View style={styles.cell}>
          <GenreCard genre={genre} layout="grid" onPress={() => router.push(`/genre/${genre.id}`)} />
        </View>
      )}
      numColumns={2}
      emptyTitle="No genres found"
      emptyMessage="Genres appear here once tracks are tagged."
      testID="genre-list-screen"
    />
  );
}

const styles = StyleSheet.create({
  cell: {
    flex: 1,
    marginBottom: spacing.sm,
  },
});
