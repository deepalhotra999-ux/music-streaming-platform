// Phase 14 — audio ingestion status badge.
//
// Shows where a track sits in the upload -> transcode -> READY pipeline.
// Separate from StatusBadge (the catalog draft/published state): a track
// can be a published READY track while its audio is being re-processed,
// and a FAILED audio pipeline never unpublishes the catalog entry.

import { StyleSheet, Text, View } from 'react-native';
import type { AudioIngestStatus } from '../../api';
import { colors, fontSize, fontWeight, radii, spacing } from '../../theme';

const LABELS: Record<AudioIngestStatus, string> = {
  NONE: 'No audio',
  PENDING: 'Queued',
  PROCESSING: 'Processing',
  READY: 'Audio ready',
  FAILED: 'Audio failed',
};

const BADGE_COLORS: Record<AudioIngestStatus, string> = {
  NONE: colors.textMuted,
  PENDING: colors.warning,
  PROCESSING: colors.warning,
  READY: colors.success,
  FAILED: colors.error,
};

export function AudioStatusBadge({
  status,
  testID,
}: {
  status: AudioIngestStatus;
  testID?: string;
}) {
  return (
    <View
      style={[styles.badge, { borderColor: BADGE_COLORS[status] }]}
      testID={testID ?? `audio-status-badge-${status}`}
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
