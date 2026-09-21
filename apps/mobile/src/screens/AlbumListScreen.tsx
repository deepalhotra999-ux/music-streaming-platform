// Phase 6 — album list: paginated new releases (release date, newest first).

import { useRouter } from 'expo-router';
import { listAlbums } from '../api';
import { useAuth } from '../auth';
import { AlbumRow, CatalogListScreen } from '../catalog';

export function AlbumListScreen() {
  const { api } = useAuth();
  const router = useRouter();

  return (
    <CatalogListScreen
      fetchPage={(page) => listAlbums(api, { page, limit: 20 })}
      keyExtractor={(album) => album.id}
      renderItem={(album) => (
        <AlbumRow album={album} onPress={() => router.push(`/album/${album.id}`)} />
      )}
      emptyTitle="No albums found"
      emptyMessage="Check back later — new releases land here first."
      testID="album-list-screen"
    />
  );
}
