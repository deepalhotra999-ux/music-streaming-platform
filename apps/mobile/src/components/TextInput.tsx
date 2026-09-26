// Phase 5 — design system: labeled text input with error + secure entry.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput as RNTextInput, View } from 'react-native';
import type { TextInputProps as RNTextInputProps } from 'react-native';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

interface TextInputProps extends Omit<RNTextInputProps, 'style'> {
  label: string;
  /** Phase 31 — marks the field required: visual "*" and "required" in the
   * accessible name. */
  required?: boolean;
  error?: string;
  testID?: string;
}

export function TextInput({
  label,
  required = false,
  error,
  testID,
  secureTextEntry,
  ...rest
}: TextInputProps) {
  const [hidden, setHidden] = useState(Boolean(secureTextEntry));
  const inputTestID = testID ?? `input-${label.toLowerCase().replace(/\s+/g, '-')}`;
  // One coherent accessible name: label, required state, and current error.
  // The error is also announced separately via the live region below.
  const accessibleName = `${label}${required ? ', required' : ''}${error ? `. ${error}` : ''}`;
  return (
    <View>
      <Text style={styles.label}>
        {label}
        {required ? <Text style={styles.required}> *</Text> : null}
      </Text>
      <View style={[styles.field, error ? styles.fieldError : null]}>
        <RNTextInput
          testID={inputTestID}
          style={styles.input}
          placeholderTextColor={colors.textFaint}
          secureTextEntry={secureTextEntry ? hidden : false}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={accessibleName}
          {...rest}
        />
        {secureTextEntry ? (
          <Pressable
            testID={`${inputTestID}-toggle`}
            accessibilityRole="button"
            accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
            onPress={() => setHidden((value) => !value)}
            style={styles.toggle}
            hitSlop={12}
          >
            <Text style={styles.toggleLabel}>{hidden ? 'Show' : 'Hide'}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text
          testID={`${inputTestID}-error`}
          style={styles.error}
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    marginBottom: spacing.xs,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    minHeight: 52,
  },
  fieldError: { borderColor: colors.error },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
    paddingVertical: spacing.sm,
  },
  toggle: { paddingLeft: spacing.sm },
  toggleLabel: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  error: { color: colors.error, fontSize: fontSize.xs, marginTop: spacing.xs },
  required: { color: colors.error, fontWeight: fontWeight.bold },
});
