// Phase 5 — Home placeholder. Real browse rails arrive in a later phase.

import { EmptyState, Screen } from '../components';

export function HomeScreen() {
  return (
    <Screen scrollable={false} testID="home-screen">
      <EmptyState
        title="Home is coming soon"
        message="Personalized rails, new releases, and your heavy rotation will live here."
      />
    </Screen>
  );
}
