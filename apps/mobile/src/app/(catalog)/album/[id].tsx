import { useLocalSearchParams } from 'expo-router';
import { AlbumDetailScreen } from '../../../screens';

export default function AlbumDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <AlbumDetailScreen albumId={id} />;
}
