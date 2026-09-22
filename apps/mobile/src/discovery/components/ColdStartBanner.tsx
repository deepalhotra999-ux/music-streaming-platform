// Phase 26 — honest cold-start banner.
//
// When the backend reports policy.personalized === false, the feed is NOT
// personalized. This banner says so plainly and explains what the user is
// seeing instead (popular / new / emerging picks). It is a hard rule:
// cold-start UI must never carry "for you" language.

import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, spacing } from '../../theme';

export function ColdStartBanner({ testID }: { testID?: string }) {
  return (
    <View
      style={styles.banner}
      testID={testID ?? 'cold-start-banner'}
      accessibilityRole="text"
      accessibilityLabel="New here? These picks are not personalized yet. Like tracks and follow artists to get recommendations made for you."
    >
      <Ionicons name="sparkles-outline" size={20} color={colors.primary} />
      <View style={styles.texts}>
        <Text style={styles.title}>New here? Start exploring</Text>
        <Text style={styles.message}>
          These picks aren&apos;t personalized yet. Like tracks and follow artists and this feed
          will become yours.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceElevated,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  texts: { flex: 1 },
  title: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginBottom: 2,
  },
  message: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.5,
  },
});
