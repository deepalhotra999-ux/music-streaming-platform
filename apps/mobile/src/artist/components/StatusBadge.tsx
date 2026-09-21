// Phase 13 — track status badge.
//
// The backend TrackStatus is the closest the model gets to a
// draft/published distinction: PROCESSING tracks are not yet playable
// (created via the API with no uploaded audio), READY tracks are
// publicly available, FAILED/TAKEDOWN are unavailable. The badge makes
// that state visible in the artist area so drafts are never confused
// with published content.

import { StyleSheet, Text, View } from 'react-native';
import type { TrackStatus } from '../../api';
import { colors, fontSize, fontWeight, radii, spacing } from '../../theme';

const LABELS: Record<TrackStatus, string> = {
  PROCESSING: 'Draft',
  READY: 'Published',
  FAILED: 'Failed',
  TAKEDOWN: 'Taken down',
};

const BADGE_COLORS: Record<TrackStatus, string> = {
  PROCESSING: colors.warning,
  READY: colors.success,
  FAILED: colors.error,
  TAKEDOWN: colors.textMuted,
};

export function StatusBadge({ status, testID }: { status: TrackStatus; testID?: string }) {
  return (
    <View
      style={[styles.badge, { borderColor: BADGE_COLORS[status] }]}
      testID={testID ?? `status-badge-${status}`}
    >
      <Text style={[styles.label, { color: BADGE_COLORS[status] }]}>{LABELS[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
});
