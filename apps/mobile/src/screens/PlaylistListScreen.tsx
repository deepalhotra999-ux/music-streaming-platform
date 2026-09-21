// Phase 6 — public playlist browsing: paginated list of PUBLIC playlists,
// newest first. No token required (the API serves this endpoint anonymously).

import { useRouter } from 'expo-router';
import { listPublicPlaylists } from '../api';
import { useAuth } from '../auth';
import { CatalogListScreen, PlaylistRow } from '../catalog';

export function PlaylistListScreen() {
  const { api } = useAuth();
  const router = useRouter();

  return (
    <CatalogListScreen
      fetchPage={(page) => listPublicPlaylists(api, { page, limit: 20 })}
      keyExtractor={(playlist) => playlist.id}
      renderItem={(playlist) => (
        <PlaylistRow playlist={playlist} onPress={() => router.push(`/playlist/${playlist.id}`)} />
      )}
      emptyTitle="No public playlists yet"
      emptyMessage="Public playlists from the community will appear here."
      testID="playlist-list-screen"
    />
  );
}
