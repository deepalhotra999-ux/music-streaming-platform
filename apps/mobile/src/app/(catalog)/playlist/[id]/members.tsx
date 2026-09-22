import { useLocalSearchParams } from 'expo-router';
import { PlaylistMembersScreen } from '../../../../screens';

export default function PlaylistMembersRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PlaylistMembersScreen playlistId={id} />;
}
