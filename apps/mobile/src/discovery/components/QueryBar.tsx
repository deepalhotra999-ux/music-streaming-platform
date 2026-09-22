// Phase 26 — natural-language discovery input.
//
// A single text field plus a submit button. The query goes to
// POST /v1/discovery/query; the backend (AI or deterministic parser)
// turns it into structured constraints. This component only collects
// the text — interpretation and validation stay server-side.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput as RNTextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, radii, spacing } from '../../theme';

interface QueryBarProps {
  onSubmit: (query: string) => void;
  loading: boolean;
  testID?: string;
}

const MAX_LENGTH = 500;

export function QueryBar({ onSubmit, loading, testID }: QueryBarProps) {
  const [value, setValue] = useState('');
  const canSubmit = value.trim().length > 0 && !loading;

  const submit = () => {
    if (canSubmit) {
      onSubmit(value.trim());
    }
  };

  return (
    <View style={styles.container} testID={testID ?? 'discovery-query-bar'}>
      <View style={styles.field}>
        <Ionicons name="sparkles" size={18} color={colors.primary} />
        <RNTextInput
          testID="discovery-query-input"
          style={styles.input}
          value={value}
          onChangeText={setValue}
          onSubmitEditing={submit}
          returnKeyType="search"
          placeholder="Describe the vibe… e.g. “mellow evening jazz”"
          placeholderTextColor={colors.textFaint}
          maxLength={MAX_LENGTH}
          editable={!loading}
          accessibilityLabel="Describe what you want to hear"
          accessibilityHint="Type a mood, genre, or activity and submit to get recommendations"
        />
        {value.length > 0 ? (
          <Pressable
            onPress={() => setValue('')}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Clear query"
            testID="discovery-query-clear"
          >
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      <Pressable
        onPress={submit}
        disabled={!canSubmit}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Find music"
        accessibilityState={{ disabled: !canSubmit, busy: loading }}
        style={({ pressed }) => [
          styles.button,
          !canSubmit && styles.buttonDisabled,
          pressed && canSubmit && styles.buttonPressed,
        ]}
        testID="discovery-query-submit"
      >
        <Text style={styles.buttonText}>{loading ? '…' : 'Find'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    minHeight: 52,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
    paddingVertical: spacing.sm,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 72,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.8 },
  buttonText: {
    color: '#FFFFFF',
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});
