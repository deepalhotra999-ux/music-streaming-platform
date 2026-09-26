// Phase 31 — accessible icon button.
//
// Icon-only controls must expose an accessible name; the visual icon alone
// is never enough. This component enforces a label, the button role, and a
// minimum 44pt touch target (via min dimensions, not just hitSlop, so the
// target is also correct for switch/voice control).

import type { ComponentProps } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

interface IconButtonProps {
  icon: IconName;
  /** Accessible name, e.g. "Play", "Close", "Add to cart". Required. */
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Toggle state, e.g. shuffle on/off, liked/unliked. */
  selected?: boolean;
  size?: number;
  color?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  icon,
  label,
  onPress,
  disabled = false,
  selected = false,
  size = 24,
  color,
  testID,
  style,
}: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      style={({ pressed }) => [styles.base, pressed && !disabled && styles.pressed, style]}
      testID={testID}
    >
      <Ionicons
        name={icon}
        size={size}
        color={color ?? (disabled ? colors.textFaint : selected ? colors.primary : colors.text)}
        // Decorative: the button's label carries the meaning.
        accessible={false}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xs,
  },
  pressed: { opacity: 0.6 },
});
