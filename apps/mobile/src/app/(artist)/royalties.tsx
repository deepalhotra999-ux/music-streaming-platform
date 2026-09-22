// Phase 21 — artist royalties route. Lives in the (artist) stack so the
// tab bar is hidden and the native header provides back navigation.
// ARTIST-only via the (artist) layout role guard; the backend re-checks
// ownership per request.

import { useLocalSearchParams } from 'expo-router';
import { ArtistRoyaltiesScreen } from '../../screens/ArtistRoyaltiesScreen';

export default function RoyaltiesRoute() {
  const { artistId } = useLocalSearchParams<{ artistId?: string }>();
  return <ArtistRoyaltiesScreen initialArtistId={artistId} />;
}
