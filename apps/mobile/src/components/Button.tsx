// Phase 5 — design system: Button.
// Variants: primary | secondary | ghost. Sizes: md | lg.
// Loading state replaces the label with a spinner and blocks presses.

import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'md' | 'lg';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  /** Phase 20 — accessibility label for screen readers. */
  accessibilityLabel?: string;
  /** Phase 20 — accessibility hint describing the action's result. */
  accessibilityHint?: string;
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'lg',
  loading = false,
  disabled = false,
  testID,
  style,
  accessibilityLabel,
  accessibilityHint,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        styles[size],
        pressed && !isDisabled && styles[`${variant}Pressed`],
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          testID={testID ? `${testID}-loading` : 'button-loading'}
          color={variant === 'primary' ? colors.onPrimary : colors.text}
        />
      ) : (
        <Text style={[styles.label, styles[`${variant}Label`], styles[`${size}Label`]]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  primary: { backgroundColor: colors.primaryFilled },
  primaryPressed: { backgroundColor: colors.primaryFilledPressed },
  secondary: { backgroundColor: colors.secondary },
  secondaryPressed: { backgroundColor: colors.secondaryPressed },
  ghost: { backgroundColor: 'transparent' },
  ghostPressed: { backgroundColor: colors.secondary },
  md: { minHeight: 44, paddingHorizontal: spacing.md },
  lg: { minHeight: 52, paddingHorizontal: spacing.lg },
  disabled: { opacity: 0.5 },
  label: { fontWeight: fontWeight.semibold },
  primaryLabel: { color: colors.onPrimary },
  secondaryLabel: { color: colors.text },
  ghostLabel: { color: colors.primary },
  mdLabel: { fontSize: fontSize.sm },
  lgLabel: { fontSize: fontSize.md },
});
