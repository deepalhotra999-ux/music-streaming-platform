// Phase 5 — Library placeholder. Real library/playlists arrive in a later phase.

import { EmptyState, Screen } from '../components';

export function LibraryScreen() {
  return (
    <Screen scrollable={false} testID="library-screen">
      <EmptyState
        title="Your library is coming soon"
        message="Playlists, liked tracks, and followed artists will live here."
      />
    </Screen>
  );
}
