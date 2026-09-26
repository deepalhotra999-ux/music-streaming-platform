// Phase 9 — transport controls: shuffle, previous, play/pause, next, repeat.
//
// Pure presentational component: all state comes from the engine snapshot
// via props, so it is fully testable without the engine. The central
// button shows a spinner while the session is being minted ('loading'); in
// every other state it toggles play/pause (the engine maps play-from-error
// to retry).

import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PlaybackState, RepeatMode } from '../playback';
import { colors, fontSize, fontWeight, spacing } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

interface ControlButtonProps {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Active toggle state (shuffle on, repeat on). */
  active?: boolean;
  /** Small badge rendered over the icon (repeat-one shows "1"). */
  badge?: string;
  size?: number;
  testID?: string;
}

function ControlButton({
  icon,
  label,
  onPress,
  disabled = false,
  active = false,
  badge,
  size = 26,
  testID,
}: ControlButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      style={({ pressed }) => [styles.control, pressed && !disabled && styles.pressed]}
      testID={testID}
    >
      <Ionicons
        name={icon}
        size={size}
        color={disabled ? colors.textFaint : active ? colors.primary : colors.text}
      />
      {badge ? <Text style={styles.badge}>{badge}</Text> : null}
    </Pressable>
  );
}

export interface PlayerControlsProps {
  state: PlaybackState;
  canNext: boolean;
  canPrevious: boolean;
  shuffle: boolean;
  repeatMode: RepeatMode;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  /** Phase 28 — room participants get a read-only player: every transport
      button (including shuffle/repeat) is disabled. */
  transportDisabled?: boolean;
}

export function PlayerControls({
  state,
  canNext,
  canPrevious,
  shuffle,
  repeatMode,
  onToggle,
  onNext,
  onPrevious,
  onToggleShuffle,
  onCycleRepeat,
  transportDisabled = false,
}: PlayerControlsProps) {
  const busy = state === 'loading';
  const playing = state === 'playing' || state === 'buffering';
  const disabled = state === 'error' || state === 'idle' || transportDisabled;
  const repeatLabel =
    repeatMode === 'off' ? 'Repeat off' : repeatMode === 'all' ? 'Repeat all' : 'Repeat one';

  return (
    <View style={styles.row} testID="player-controls">
      <ControlButton
        icon="shuffle"
        label={shuffle ? 'Shuffle on' : 'Shuffle off'}
        onPress={onToggleShuffle}
        disabled={disabled}
        active={shuffle}
        size={24}
        testID="controls-shuffle"
      />
      <ControlButton
        icon="play-skip-back"
        label="Previous"
        onPress={onPrevious}
        disabled={disabled || !canPrevious}
        size={34}
        testID="controls-previous"
      />
      <Pressable
        onPress={onToggle}
        disabled={busy || disabled}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause' : 'Play'}
        accessibilityState={{ disabled: busy || disabled }}
        style={({ pressed }) => [
          styles.playButton,
          pressed && !busy && !disabled && styles.pressed,
        ]}
        testID="controls-toggle"
      >
        {busy ? (
          <ActivityIndicator color={colors.onPrimary} testID="controls-loading" />
        ) : (
          <Ionicons name={playing ? 'pause' : 'play'} size={34} color={colors.onPrimary} />
        )}
      </Pressable>
      <ControlButton
        icon="play-skip-forward"
        label="Next"
        onPress={onNext}
        disabled={disabled || !canNext}
        size={34}
        testID="controls-next"
      />
      <ControlButton
        icon="repeat"
        label={repeatLabel}
        onPress={onCycleRepeat}
        disabled={disabled}
        active={repeatMode !== 'off'}
        badge={repeatMode === 'one' ? '1' : undefined}
        size={24}
        testID="controls-repeat"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
  },
  control: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  playButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primaryFilled,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 6,
    right: 8,
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
});
