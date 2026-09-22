// Phase 27 — collaborative playlist badge + role indicator.
//
// Rendered on playlist rows and the detail header whenever
// `isCollaborative` is true. `viewerRole` is shown where the detail
// payload carries it (list rows don't have it).

import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ViewerRole } from '../../api';
import { colors, fontSize, fontWeight, spacing } from '../../theme';

export function CollaborativeBadge({
  viewerRole,
  testID = 'collaborative-badge',
}: {
  viewerRole?: ViewerRole | null;
  testID?: string;
}) {
  const roleLabel =
    viewerRole === 'EDITOR' ? ' • Editor' : viewerRole === 'OWNER' ? ' • Owner' : '';
  return (
    <View style={styles.badge} testID={testID}>
      <Ionicons name="people" size={fontSize.xs} color={colors.textMuted} />
      <Text style={styles.text}>Collaborative{roleLabel}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
  },
  text: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
});
