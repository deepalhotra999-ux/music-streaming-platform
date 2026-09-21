import { Stack, useLocalSearchParams } from 'expo-router';
import { TrackListScreen } from '../../screens';

export default function TracksRoute() {
  const { artistId, artistName, genreId } = useLocalSearchParams<{
    artistId?: string;
    artistName?: string;
    genreId?: string;
  }>();
  return (
    <>
      <Stack.Screen options={{ title: artistName ?? 'Tracks' }} />
      <TrackListScreen artistId={artistId} genreId={genreId} />
    </>
  );
}
