// Phase 26 — a recommendation row: track metadata plus the truthful
// reason the backend gave. The reason is display-only copy from the
// server; the client never invents or rewords it.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { formatDuration } from '../../catalog/format';
import { ArtworkImage } from '../../catalog/components/ArtworkImage';
import type { RecommendationItem } from '../types';

interface DiscoveryTrackRowProps {
  item: RecommendationItem;
  index: number;
  onPress: () => void;
  onLongPress: () => void;
  testID?: string;
}

export function DiscoveryTrackRow({
  item,
  index,
  onPress,
  onLongPress,
  testID,
}: DiscoveryTrackRowProps) {
  const { track, reason } = item;
  const label = `${track.title} by ${track.artist.name}. ${reason}`;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Plays the track. Long press for more options."
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID ?? `discovery-track-${index}`}
    >
      <ArtworkImage uri={null} title={track.title} seed={track.album?.id ?? track.id} size={48} />
      <View style={styles.texts}>
        <Text style={styles.title} numberOfLines={1}>
          {track.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {track.artist.name}
          {track.album ? ` · ${track.album.title}` : ''}
        </Text>
        <Text style={styles.reason} numberOfLines={2}>
          {reason}
        </Text>
      </View>
      <Text style={styles.duration}>{formatDuration(track.durationMs)}</Text>
      <Ionicons name="ellipsis-horizontal" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  pressed: { opacity: 0.6 },
  texts: { flex: 1, minWidth: 0 },
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  reason: {
    color: colors.primary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  duration: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontVariant: ['tabular-nums'],
  },
});
