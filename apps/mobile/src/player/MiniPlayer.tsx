// Phase 9 — mini player: the persistent compact bar.
//
// MiniPlayerView is pure (props in, callbacks out) for tests; MiniPlayer is
// the thin hooked wrapper that reads the engine and navigates to the full
// player. The bar stays mounted at the app root while the queue is active,
// so it survives tab switches and catalog navigation.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import type { PlaybackState, QueueTrack } from '../playback';
import { usePlayback } from '../playback';
import { useRoom } from '../rooms';
import { ArtworkImage } from '../catalog';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';
import { MINI_PLAYER_HEIGHT } from './constants';

export interface MiniPlayerViewProps {
  track: QueueTrack;
  state: PlaybackState;
  positionMs: number;
  durationMs: number;
  /** Phase 25 — show the offline badge when playing a local download. */
  isOfflinePlayback?: boolean;
  /** Phase 28 — show the room badge while synchronized in a room. */
  inRoom?: boolean;
  onToggle: () => void;
  onClose: () => void;
  onExpand: () => void;
}

export function MiniPlayerView({
  track,
  state,
  positionMs,
  durationMs,
  isOfflinePlayback = false,
  inRoom = false,
  onToggle,
  onClose,
  onExpand,
}: MiniPlayerViewProps) {
  const busy = state === 'loading' || state === 'buffering';
  const errored = state === 'error';
  const playing = state === 'playing' || state === 'buffering';
  const ratio = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  // In error state the engine maps play() to retry(), so the toggle doubles
  // as the one-tap recovery.
  const toggleIcon = errored ? 'refresh' : playing ? 'pause' : 'play';
  const toggleLabel = errored ? 'Retry' : playing ? 'Pause' : 'Play';

  return (
    <View style={styles.bar} testID="mini-player">
      <Pressable
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel={`Open player: ${track.title} by ${track.artistName}${errored ? ', playback error' : ''}`}
        style={({ pressed }) => [styles.info, pressed && styles.pressed]}
        testID="mini-player-expand"
      >
        <ArtworkImage
          uri={track.artworkUrl}
          title={track.albumTitle ?? track.title}
          seed={track.albumId ?? track.trackId}
          size={44}
        />
        <View style={styles.texts}>
          <Text style={styles.title} numberOfLines={1}>
            {track.title}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {track.artistName}
            {isOfflinePlayback ? ' · Offline' : ''}
            {inRoom ? ' · Room' : ''}
          </Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={colors.primary} testID="mini-player-loading" />
        ) : null}
        {errored ? (
          <Ionicons name="alert-circle" size={20} color={colors.error} testID="mini-player-error" />
        ) : null}
      </Pressable>
      <Pressable
        onPress={onToggle}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={toggleLabel}
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        testID="mini-player-toggle"
      >
        {busy && !playing ? (
          <ActivityIndicator size="small" color={colors.text} testID="mini-player-loading" />
        ) : (
          <Ionicons name={toggleIcon} size={26} color={colors.text} />
        )}
      </Pressable>
      <Pressable
        onPress={onClose}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close player"
        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        testID="mini-player-close"
      >
        <Ionicons name="close" size={20} color={colors.textMuted} />
      </Pressable>
      <View style={styles.progressTrack} pointerEvents="none">
        <View style={[styles.progressFill, { width: `${ratio * 100}%` }]} />
      </View>
    </View>
  );
}

export function MiniPlayer() {
  const playback = usePlayback();
  const router = useRouter();
  // Phase 28 — in a room the mini player is an indicator + shortcut: the
  // host's toggle drives the room, participants keep their local toggle
  // as an escape hatch (the drift corrector leaves deliberate pauses
  // alone; the room screen offers resync).
  const room = useRoom();
  const inRoom = room.room != null && room.status !== 'ended';
  const roomHost = inRoom && room.isHost;
  const roomPlaying = room.room?.playbackState === 'PLAYING';
  if (!playback.track) {
    return null;
  }
  return (
    <MiniPlayerView
      track={playback.track}
      state={playback.state}
      positionMs={playback.positionMs}
      durationMs={playback.durationMs}
      isOfflinePlayback={playback.isOfflinePlayback}
      inRoom={inRoom}
      onToggle={
        inRoom && roomHost
          ? () => (roomPlaying ? room.hostPause() : room.hostPlay())
          : playback.toggle
      }
      onClose={playback.stop}
      onExpand={() => router.push('/player')}
    />
  );
}

const styles = StyleSheet.create({
  bar: {
    height: MINI_PLAYER_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingLeft: spacing.sm,
    paddingRight: spacing.xs,
    overflow: 'hidden',
  },
  info: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.6 },
  texts: { flex: 1, minWidth: 0 },
  title: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  artist: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 2,
    backgroundColor: colors.border,
  },
  progressFill: {
    height: 2,
    backgroundColor: colors.primary,
  },
});
