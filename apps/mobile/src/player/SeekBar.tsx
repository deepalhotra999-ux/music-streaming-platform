// Phase 9 — seek bar.
//
// A dependency-free slider: tap or drag anywhere on the bar to seek. While
// the finger is down the knob follows the touch (scrub preview); the seek
// commits on release. Direct touch handlers (no PanResponder) keep the
// commit path fully testable; see positionMsForX and the tests.

import { useRef, useState } from 'react';
import type { AccessibilityActionEvent, LayoutChangeEvent } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { colors } from '../theme';
import { formatDuration } from '../catalog';
import { SEEK_STEP_MS } from './constants';

/** Map a horizontal touch position to a seek target. Pure and unit-tested. */
export function positionMsForX(x: number, width: number, durationMs: number): number {
  if (width <= 0 || durationMs <= 0) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, x / width));
  return Math.round(ratio * durationMs);
}

interface SeekBarProps {
  positionMs: number;
  durationMs: number;
  disabled?: boolean;
  onSeek: (positionMs: number) => void;
  testID?: string;
}

export function SeekBar({
  positionMs,
  durationMs,
  disabled = false,
  onSeek,
  testID,
}: SeekBarProps) {
  const [width, setWidth] = useState(0);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  // Touch callbacks are re-created per render; read latest values via ref
  // so a touch sequence that spans renders stays consistent.
  const latest = useRef({ width, durationMs, onSeek, disabled });
  latest.current = { width, durationMs, onSeek, disabled };

  const targetFor = (x: number) =>
    positionMsForX(x, latest.current.width, latest.current.durationMs);

  const onLayout = (evt: LayoutChangeEvent) => {
    setWidth(evt.nativeEvent.layout.width);
  };

  const onAccessibilityAction = (evt: AccessibilityActionEvent) => {
    const delta = evt.nativeEvent.actionName === 'increment' ? SEEK_STEP_MS : -SEEK_STEP_MS;
    onSeek(Math.min(durationMs, Math.max(0, positionMs + delta)));
  };

  const displayMs = scrubMs ?? positionMs;
  const ratio = durationMs > 0 ? Math.min(1, Math.max(0, displayMs / durationMs)) : 0;

  return (
    <View
      onLayout={onLayout}
      onTouchStart={(evt) => {
        if (latest.current.disabled) return;
        setScrubMs(targetFor(evt.nativeEvent.locationX));
      }}
      onTouchMove={(evt) => {
        if (latest.current.disabled) return;
        setScrubMs(targetFor(evt.nativeEvent.locationX));
      }}
      onTouchEnd={(evt) => {
        if (latest.current.disabled) return;
        const target = targetFor(evt.nativeEvent.locationX);
        setScrubMs(null);
        latest.current.onSeek(target);
      }}
      onTouchCancel={() => setScrubMs(null)}
      accessibilityRole="adjustable"
      accessibilityLabel="Seek"
      accessibilityValue={{
        min: 0,
        max: Math.round(durationMs),
        now: Math.round(positionMs),
        // Phase 31 — raw milliseconds are meaningless when announced;
        // expose a human-readable position/duration instead.
        text: `${formatDuration(positionMs)} of ${formatDuration(durationMs)}`,
      }}
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={onAccessibilityAction}
      testID={testID ?? 'seek-bar'}
      style={styles.touchArea}
    >
      <View style={styles.track}>
        <View style={[styles.progress, { width: `${ratio * 100}%` }]} />
      </View>
      <View style={[styles.knob, { left: `${ratio * 100}%` }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Tall touch target; the visible bar is vertically centered.
  touchArea: {
    height: 36,
    justifyContent: 'center',
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  progress: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
  knob: {
    position: 'absolute',
    top: '50%',
    width: 14,
    height: 14,
    borderRadius: 7,
    marginLeft: -7,
    marginTop: -7,
    backgroundColor: colors.text,
  },
});
