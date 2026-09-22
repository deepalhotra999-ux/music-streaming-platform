// Phase 26 — emerging-artist row: name, stream count, and a chevron.
// Tapping opens the artist detail screen (handled by the caller).

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import type { EmergingArtist } from '../types';

interface EmergingArtistRowProps {
  artist: EmergingArtist;
  index: number;
  onPress: () => void;
  testID?: string;
}

function formatStreams(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k streams`;
  return `${count} stream${count === 1 ? '' : 's'}`;
}

export function EmergingArtistRow({ artist, index, onPress, testID }: EmergingArtistRowProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${artist.artistName}, emerging artist, ${formatStreams(artist.recentStreams)} recently`}
      accessibilityHint="Opens the artist page"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={testID ?? `emerging-artist-${index}`}
    >
      <View style={styles.badge}>
        <Ionicons name="trending-up" size={18} color={colors.primary} />
      </View>
      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1}>
          {artist.artistName}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {formatStreams(artist.recentStreams)} · growing now
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
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
  badge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  texts: { flex: 1, minWidth: 0 },
  name: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.medium,
  },
  meta: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
});
