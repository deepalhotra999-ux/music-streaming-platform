import { useLocalSearchParams } from 'expo-router';
import { GenreDetailScreen } from '../../../screens';

export default function GenreDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <GenreDetailScreen genreId={id} />;
}
