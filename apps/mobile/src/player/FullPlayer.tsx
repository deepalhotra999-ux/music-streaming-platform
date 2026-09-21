// Phase 9 — full-screen player.
//
// FullPlayerView is pure (props in, callbacks out) for tests; FullPlayer is
// the thin hooked wrapper that reads the engine snapshot and dismisses via
// the router. Presented as a full-screen modal route (app/player.tsx).

import { useCallback, useEffect } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { PlaybackState, QueueTrack, RepeatMode } from '../playback';
import { usePlayback } from '../playback';
import { ArtworkImage, formatDuration } from '../catalog';
import { Button } from '../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';
import { PlayerControls } from './PlayerControls';
import { QueueList } from './QueueView';
import { SeekBar } from './SeekBar';

export interface FullPlayerViewProps {
  track: QueueTrack;
  state: PlaybackState;
  positionMs: number;
  durationMs: number;
  queue: QueueTrack[];
  trackIndex: number;
  canNext: boolean;
  canPrevious: boolean;
  shuffle: boolean;
  repeatMode: RepeatMode;
  error: string | null;
  /** Phase 18 — playback denied for lack of subscription. */
  locked: boolean;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (positionMs: number) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  onPlayAt: (index: number) => void;
  onRemoveAt: (index: number) => void;
  onRetry: () => void;
  onMinimize: () => void;
}

const ARTWORK_SIZE = 280;

export function FullPlayerView({
  track,
  state,
  positionMs,
  durationMs,
  queue,
  trackIndex,
  canNext,
  canPrevious,
  shuffle,
  repeatMode,
  error,
  locked,
  onToggle,
  onNext,
  onPrevious,
  onSeek,
  onToggleShuffle,
  onCycleRepeat,
  onPlayAt,
  onRemoveAt,
  onRetry,
  onMinimize,
}: FullPlayerViewProps) {
  const errored = state === 'error';
  const busy = state === 'loading' || state === 'buffering';
  // Fall back to the catalog duration until the player reports the real one.
  const displayDuration = durationMs > 0 ? durationMs : (track.durationMs ?? 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']} testID="full-player">
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Pressable
            onPress={onMinimize}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Minimize player"
            style={({ pressed }) => [styles.minimize, pressed && styles.pressed]}
            testID="full-player-minimize"
          >
            <Ionicons name="chevron-down" size={28} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>Now playing</Text>
          <View style={styles.minimize} />
        </View>

        <View style={styles.artworkWrap}>
          <ArtworkImage
            uri={track.artworkUrl}
            title={track.albumTitle ?? track.title}
            seed={track.albumId ?? track.trackId}
            size={ARTWORK_SIZE}
            shape="rounded"
            testID="full-player-artwork"
          />
          {busy ? (
            <View style={styles.artworkBusy} pointerEvents="none">
              <ActivityIndicator size="large" color={colors.text} testID="full-player-loading" />
            </View>
          ) : null}
        </View>

        <Text style={styles.title} numberOfLines={2} testID="full-player-title">
          {track.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1} testID="full-player-artist">
          {track.artistName}
        </Text>

        <View style={styles.seekSection}>
          <SeekBar
            positionMs={positionMs}
            durationMs={durationMs}
            disabled={durationMs === 0 || errored}
            onSeek={onSeek}
            testID="full-player-seek"
          />
          <View style={styles.times}>
            <Text style={styles.time} testID="full-player-position">
              {formatDuration(positionMs)}
            </Text>
            <Text style={styles.time} testID="full-player-duration">
              {formatDuration(displayDuration)}
            </Text>
          </View>
        </View>

        {locked ? (
          <View style={styles.lockedBanner} testID="full-player-locked">
            <Ionicons name="lock-closed" size={20} color={colors.warning} />
            <Text style={styles.lockedText} numberOfLines={3}>
              Premium required to play this track.
            </Text>
          </View>
        ) : errored ? (
          <View style={styles.errorBanner} testID="full-player-error">
            <Ionicons name="alert-circle" size={20} color={colors.error} />
            <Text style={styles.errorText} numberOfLines={3}>
              {error ?? 'Playback failed.'}
            </Text>
            <Button title="Retry" onPress={onRetry} testID="full-player-retry" />
          </View>
        ) : null}

        <PlayerControls
          state={state}
          canNext={canNext}
          canPrevious={canPrevious}
          shuffle={shuffle}
          repeatMode={repeatMode}
          onToggle={onToggle}
          onNext={onNext}
          onPrevious={onPrevious}
          onToggleShuffle={onToggleShuffle}
          onCycleRepeat={onCycleRepeat}
        />

        <Text style={styles.queueTitle}>Up next</Text>
        <View style={styles.queuePad}>
          <QueueList
            queue={queue}
            trackIndex={trackIndex}
            onPlayAt={onPlayAt}
            onRemoveAt={onRemoveAt}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function FullPlayer() {
  const playback = usePlayback();
  const router = useRouter();

  const minimize = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  }, [router]);

  // If playback was closed (mini player × or sign-out), dismiss the modal.
  useEffect(() => {
    if (!playback.track) {
      minimize();
    }
  }, [playback.track, minimize]);

  const cycleRepeat = useCallback(() => {
    const next: RepeatMode =
      playback.repeatMode === 'off' ? 'all' : playback.repeatMode === 'all' ? 'one' : 'off';
    playback.setRepeatMode(next);
  }, [playback]);

  const toggleShuffle = useCallback(() => {
    playback.setShuffle(!playback.shuffle);
  }, [playback]);

  if (!playback.track) {
    return null;
  }

  return (
    <FullPlayerView
      track={playback.track}
      state={playback.state}
      positionMs={playback.positionMs}
      durationMs={playback.durationMs}
      queue={playback.queue}
      trackIndex={playback.trackIndex}
      canNext={playback.canNext}
      canPrevious={playback.canPrevious}
      shuffle={playback.shuffle}
      repeatMode={playback.repeatMode}
      error={playback.error}
      locked={playback.locked}
      onToggle={playback.toggle}
      onNext={playback.next}
      onPrevious={playback.previous}
      onSeek={(ms) => {
        void playback.seekTo(ms);
      }}
      onToggleShuffle={toggleShuffle}
      onCycleRepeat={cycleRepeat}
      onPlayAt={playback.playAt}
      onRemoveAt={playback.removeAt}
      onRetry={() => {
        void playback.retry();
      }}
      onMinimize={minimize}
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scrollContent: { paddingBottom: spacing.xxl },
  pressed: { opacity: 0.6 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  minimize: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  artworkWrap: {
    alignItems: 'center',
    marginTop: spacing.md,
  },
  artworkBusy: {
    position: 'absolute',
    width: ARTWORK_SIZE,
    height: ARTWORK_SIZE,
    borderRadius: Math.max(6, ARTWORK_SIZE * 0.12),
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
  },
  artist: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xl,
  },
  seekSection: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -spacing.xs,
  },
  time: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontVariant: ['tabular-nums'],
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.errorMuted,
    borderRadius: radii.md,
  },
  errorText: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.sm,
  },
  lockedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  lockedText: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  queueTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  queuePad: {
    paddingHorizontal: spacing.lg,
  },
});
