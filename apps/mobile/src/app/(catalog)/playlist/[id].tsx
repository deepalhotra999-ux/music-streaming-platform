import { useLocalSearchParams } from 'expo-router';
import { PlaylistDetailScreen } from '../../../screens';

export default function PlaylistDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PlaylistDetailScreen playlistId={id} />;
}
