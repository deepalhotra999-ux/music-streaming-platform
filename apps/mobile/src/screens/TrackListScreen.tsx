// Phase 6 — track list: paginated tracks, optionally filtered by artist or
// genre. Tapping a track opens its album (or the artist when the track has
// no album); there is no player in this phase.

import type { ReactElement } from 'react';
import { useRouter } from 'expo-router';
import { listTracks } from '../api';
import { useAuth } from '../auth';
import { CatalogListScreen, TrackRow } from '../catalog';

interface TrackListScreenProps {
  artistId?: string;
  genreId?: string;
  listHeader?: ReactElement;
  testID?: string;
}

export function TrackListScreen({ artistId, genreId, listHeader, testID }: TrackListScreenProps) {
  const { api } = useAuth();
  const router = useRouter();

  return (
    <CatalogListScreen
      fetchPage={(page) => listTracks(api, { page, limit: 20, artistId, genreId })}
      keyExtractor={(track) => track.id}
      renderItem={(track) => (
        <TrackRow
          track={track}
          onPress={() =>
            router.push(track.albumId ? `/album/${track.albumId}` : `/artist/${track.artistId}`)
          }
        />
      )}
      emptyTitle="No tracks found"
      emptyMessage="Try a different artist or genre."
      listHeader={listHeader}
      testID={testID ?? 'track-list-screen'}
    />
  );
}
