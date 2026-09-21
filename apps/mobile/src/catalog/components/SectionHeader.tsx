// Phase 6 — home section header: title + "See all" affordance.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing } from '../../theme';

interface SectionHeaderProps {
  title: string;
  onSeeAll: () => void;
  testID?: string;
}

export function SectionHeader({ title, onSeeAll, testID }: SectionHeaderProps) {
  return (
    <View style={styles.row} testID={testID}>
      <Text style={styles.title}>{title}</Text>
      <Pressable
        onPress={onSeeAll}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel={`See all ${title}`}
        style={({ pressed }) => [styles.seeAll, pressed && styles.pressed]}
      >
        <Text style={styles.seeAllText}>See all</Text>
        <Ionicons name="chevron-forward" size={fontSize.sm} color={colors.primary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  pressed: { opacity: 0.6 },
  seeAllText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
});
