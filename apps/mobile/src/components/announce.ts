// Phase 31 — screen-reader announcements for async state changes.
//
// Centralizes AccessibilityInfo.announceForAccessibility so announcements
// stay consistent and are easy to mock in tests. Use sparingly: only for
// meaningful state changes the user would otherwise miss (download
// finished, payment completed, track changed, room disconnected).

import { AccessibilityInfo } from 'react-native';

/** Announce a message to the screen reader. No-op safe. */
export function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // Screen readers may be unavailable (tests, simulators); never crash.
  }
}
