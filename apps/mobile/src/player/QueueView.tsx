// Phase 9 — queue list: the engine's queue with the current track marked,
// tap-to-jump, and per-row remove.
//
// Pure presentational components; the engine owns the queue. The rows render
// in a plain View (queues are short; no virtualization needed), so the list
// composes inside the full player's single scroll container.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { QueueTrack } from '../playback';
import { ArtworkImage, formatDuration } from '../catalog';
import { EmptyState } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

interface QueueRowProps {
  track: QueueTrack;
  index: number;
  isCurrent: boolean;
  onPlayAt: () => void;
  onRemoveAt: () => void;
}

/** One queue row: position marker, artwork, titles, duration, remove. */
export function QueueRow({ track, index, isCurrent, onPlayAt, onRemoveAt }: QueueRowProps) {
  return (
    <Pressable
      onPress={() => {
        if (!isCurrent) {
          onPlayAt();
        }
      }}
      disabled={isCurrent}
      accessibilityRole={isCurrent ? undefined : 'button'}
      accessibilityLabel={isCurrent ? `Now playing: ${track.title}` : `Play ${track.title}`}
      style={({ pressed }) => [styles.row, pressed && !isCurrent && styles.pressed]}
      testID={`queue-row-${index}`}
    >
      <View style={styles.marker}>
        {isCurrent ? (
          <Ionicons name="volume-high" size={18} color={colors.primary} testID="queue-now-playing" />
        ) : (
          <Text style={styles.index}>{index + 1}</Text>
        )}
      </View>
      <ArtworkImage
        uri={track.artworkUrl}
        title={track.albumTitle ?? track.title}
        seed={track.albumId ?? track.trackId}
        size={40}
      />
      <View style={styles.texts}>
        <Text style={[styles.title, isCurrent && styles.titleCurrent]} numberOfLines={1}>
          {track.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {track.artistName}
        </Text>
      </View>
      {track.durationMs ? (
        <Text style={styles.duration}>{formatDuration(track.durationMs)}</Text>
      ) : null}
      <Pressable
        onPress={onRemoveAt}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${track.title} from queue`}
        style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
        testID={`queue-remove-${index}`}
      >
        <Ionicons name="close" size={18} color={colors.textFaint} />
      </Pressable>
    </Pressable>
  );
}

interface QueueListProps {
  queue: QueueTrack[];
  trackIndex: number;
  onPlayAt: (index: number) => void;
  onRemoveAt: (index: number) => void;
}

export function QueueList({ queue, trackIndex, onPlayAt, onRemoveAt }: QueueListProps) {
  if (queue.length === 0) {
    return <EmptyState title="Queue is empty" message="Play a track to start the queue." />;
  }
  return (
    <View testID="queue-list">
      {queue.map((item, index) => (
        <QueueRow
          key={`${item.trackId}:${index}`}
          track={item}
          index={index}
          isCurrent={index === trackIndex}
          onPlayAt={() => onPlayAt(index)}
          onRemoveAt={() => onRemoveAt(index)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  pressed: { opacity: 0.6 },
  marker: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  index: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    fontVariant: ['tabular-nums'],
  },
  texts: { flex: 1, minWidth: 0 },
  title: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  titleCurrent: {
    color: colors.primary,
  },
  artist: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  duration: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontVariant: ['tabular-nums'],
  },
  remove: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
