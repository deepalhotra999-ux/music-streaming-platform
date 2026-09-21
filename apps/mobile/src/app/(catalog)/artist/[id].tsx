import { useLocalSearchParams } from 'expo-router';
import { ArtistDetailScreen } from '../../../screens';

export default function ArtistDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ArtistDetailScreen artistId={id} />;
}
