// Phase 9 — mini player host: the root-level overlay.
//
// Mounted once inside the authenticated layout (see app/_layout.tsx), so the
// mini player survives tab switches and catalog pushes — it is positioned
// above the tab bar on tab screens and above the bottom safe area
// elsewhere. Pure visibility logic is extracted for tests.

import { StyleSheet, View } from 'react-native';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PlaybackState, QueueTrack } from '../playback';
import { usePlayback } from '../playback';
import { spacing } from '../theme';
import { TAB_BAR_CONTENT_HEIGHT } from './constants';
import { MiniPlayer } from './MiniPlayer';

/** The mini player shows whenever a track is selected and not idle. */
export function shouldShowMiniPlayer(
  track: QueueTrack | null,
  state: PlaybackState,
  segments: string[],
): boolean {
  // Hidden on the full-player route: the host overlays the navigator, so
  // without this the bar would sit on top of the full player on surfaces
  // where the modal presentation does not cover the whole window (web).
  if (segments[0] === 'player') {
    return false;
  }
  return track !== null && state !== 'idle';
}

export function MiniPlayerHost() {
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const { track, state } = usePlayback();

  if (!shouldShowMiniPlayer(track, state, segments as string[])) {
    return null;
  }
  const inTabs = segments[0] === '(tabs)';
  return (
    <View
      style={[styles.host, { bottom: insets.bottom + (inTabs ? TAB_BAR_CONTENT_HEIGHT : 0) }]}
      pointerEvents="box-none"
      testID="mini-player-host"
    >
      <MiniPlayer />
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
  },
});
