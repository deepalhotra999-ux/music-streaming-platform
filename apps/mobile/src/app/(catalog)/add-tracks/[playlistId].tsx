import { useLocalSearchParams } from 'expo-router';
import { AddTracksScreen } from '../../../screens';

export default function AddTracksRoute() {
  const { playlistId } = useLocalSearchParams<{ playlistId: string }>();
  return <AddTracksScreen playlistId={playlistId} />;
}
