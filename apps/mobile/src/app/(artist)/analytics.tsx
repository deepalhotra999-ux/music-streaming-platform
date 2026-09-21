// Phase 15 — artist analytics route. Lives in the (artist) stack so the
// tab bar is hidden and the native header provides back navigation.
// ARTIST-only via the (artist) layout role guard; the backend re-checks
// ownership per request.

import { useLocalSearchParams } from 'expo-router';
import { ArtistAnalyticsScreen } from '../../screens/ArtistAnalyticsScreen';

export default function AnalyticsRoute() {
  const { artistId } = useLocalSearchParams<{ artistId?: string }>();
  return <ArtistAnalyticsScreen initialArtistId={artistId} />;
}
