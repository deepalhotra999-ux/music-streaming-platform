// Phase 6 — artist list: paginated A–Z catalog of artists.

import { useRouter } from 'expo-router';
import { listArtists } from '../api';
import { useAuth } from '../auth';
import { ArtistRow, CatalogListScreen } from '../catalog';

export function ArtistListScreen() {
  const { api } = useAuth();
  const router = useRouter();

  return (
    <CatalogListScreen
      fetchPage={(page) => listArtists(api, { page, limit: 20 })}
      keyExtractor={(artist) => artist.id}
      renderItem={(artist) => (
        <ArtistRow artist={artist} onPress={() => router.push(`/artist/${artist.id}`)} />
      )}
      emptyTitle="No artists found"
      emptyMessage="Check back later — new artists are added all the time."
      testID="artist-list-screen"
    />
  );
}
