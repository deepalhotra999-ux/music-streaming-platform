// Phase 12 — recent searches list.
//
// Device-local query history (see recents.ts): tap re-runs the search,
// per-row ✕ removes one entry, "Clear all" wipes the list. Rendered only
// when there is at least one entry; the parent decides the empty case.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { RecentSearch } from '../types';
import { colors, fontSize, fontWeight, spacing } from '../../theme';

interface RecentSearchesProps {
  recents: RecentSearch[];
  onSelect: (query: string) => void;
  onRemove: (query: string) => void;
  onClearAll: () => void;
  testID?: string;
}

export function RecentSearches({
  recents,
  onSelect,
  onRemove,
  onClearAll,
  testID = 'recent-searches',
}: RecentSearchesProps) {
  if (recents.length === 0) {
    return null;
  }
  return (
    <View testID={testID}>
      <View style={styles.header}>
        <Text style={styles.title}>Recent searches</Text>
        <Pressable
          testID={`${testID}-clear-all`}
          accessibilityRole="button"
          accessibilityLabel="Clear all recent searches"
          hitSlop={12}
          onPress={onClearAll}
          style={({ pressed }) => [pressed && styles.pressed]}
        >
          <Text style={styles.clearAll}>Clear all</Text>
        </Pressable>
      </View>
      {recents.map((recent) => (
        <View key={recent.query} style={styles.row}>
          <Pressable
            testID={`${testID}-item-${recent.query}`}
            accessibilityRole="button"
            accessibilityLabel={`Search again for ${recent.query}`}
            onPress={() => onSelect(recent.query)}
            style={({ pressed }) => [styles.queryWrap, pressed && styles.pressed]}
          >
            <Ionicons name="time-outline" size={fontSize.md} color={colors.textFaint} />
            <Text style={styles.query} numberOfLines={1}>
              {recent.query}
            </Text>
          </Pressable>
          <Pressable
            testID={`${testID}-remove-${recent.query}`}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${recent.query} from recent searches`}
            hitSlop={12}
            onPress={() => onRemove(recent.query)}
            style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
          >
            <Ionicons name="close" size={fontSize.md} color={colors.textFaint} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.xs,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  clearAll: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  pressed: { opacity: 0.6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.lg,
  },
  queryWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.lg,
  },
  query: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
  },
  remove: { padding: spacing.sm },
});
