// Phase 12 — search input bar.
//
// A dedicated search field (not the labeled form TextInput): leading
// search icon, clear button while text is present, search return key.
// Controlled by the parent screen.

import { Pressable, StyleSheet, TextInput as RNTextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, radii, spacing } from '../../theme';

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit?: () => void;
  testID?: string;
}

export function SearchBar({ value, onChangeText, onSubmit, testID = 'search-bar' }: SearchBarProps) {
  return (
    <View style={styles.wrap}>
      <Ionicons name="search" size={fontSize.md} color={colors.textFaint} style={styles.icon} />
      <RNTextInput
        testID={`${testID}-input`}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder="Artists, albums, tracks…"
        placeholderTextColor={colors.textFaint}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="never"
        accessibilityLabel="Search the catalog"
        onSubmitEditing={onSubmit}
      />
      {value.length > 0 ? (
        <Pressable
          testID={`${testID}-clear`}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={12}
          onPress={() => onChangeText('')}
          style={({ pressed }) => [styles.clear, pressed && styles.pressed]}
        >
          <Ionicons name="close-circle" size={fontSize.md} color={colors.textFaint} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    height: 44,
  },
  icon: { marginRight: spacing.sm },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
    height: '100%',
  },
  clear: { padding: spacing.xs },
  pressed: { opacity: 0.6 },
});
