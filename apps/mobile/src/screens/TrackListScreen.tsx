// Phase 6 — track list: paginated tracks, optionally filtered by artist or
// genre.
//
// Phase 9 — tapping a track plays it immediately (single-track queue);
// long-press appends it to the current queue.

import type { ReactElement } from 'react';
import { listTracks } from '../api';
import { useAuth } from '../auth';
import { CatalogListScreen, TrackRow } from '../catalog';
import { useQueueActions } from '../player';

interface TrackListScreenProps {
  artistId?: string;
  genreId?: string;
  listHeader?: ReactElement;
  testID?: string;
}

export function TrackListScreen({ artistId, genreId, listHeader, testID }: TrackListScreenProps) {
  const { api } = useAuth();
  const { playTracks, addToQueue } = useQueueActions();

  return (
    <CatalogListScreen
      fetchPage={(page) => listTracks(api, { page, limit: 20, artistId, genreId })}
      keyExtractor={(track) => track.id}
      renderItem={(track) => (
        <TrackRow
          track={track}
          onPress={() => void playTracks([track])}
          onLongPress={() => void addToQueue(track)}
        />
      )}
      emptyTitle="No tracks found"
      emptyMessage="Try a different artist or genre."
      listHeader={listHeader}
      testID={testID ?? 'track-list-screen'}
    />
  );
}
