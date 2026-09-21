// Phase 5 — Search placeholder. Real search arrives in a later phase.

import { EmptyState, Screen } from '../components';

export function SearchScreen() {
  return (
    <Screen scrollable={false} testID="search-screen">
      <EmptyState
        title="Search is coming soon"
        message="Find artists, albums, tracks, and playlists from here."
      />
    </Screen>
  );
}
