// Phase 22 — royalty period detail route. Lives in the (artist) stack so the
// tab bar is hidden and the native header provides back navigation.
// ARTIST-only via the (artist) layout role guard; the backend re-checks
// ownership per request.

import { useLocalSearchParams } from 'expo-router';
import { RoyaltyPeriodDetailScreen } from '../../../screens/RoyaltyPeriodDetailScreen';

export default function RoyaltyPeriodDetailRoute() {
  const { artistId, periodId } = useLocalSearchParams<{ artistId: string; periodId: string }>();
  return <RoyaltyPeriodDetailScreen artistId={artistId} periodId={periodId} />;
}
