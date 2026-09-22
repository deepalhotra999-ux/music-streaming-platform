// Phase 25 — compact per-track download button for catalog rows.
//
// Reflects the download lifecycle: download → progress/pause → resume →
// done → (failed/stale → retry). Removing a finished download happens
// from the Downloads screen, not here, so a stray tap can't wipe media.

import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { TrackSummary } from '../../api';
import { useOffline } from '../OfflineProvider';
import { colors, fontSize } from '../../theme';

interface DownloadButtonProps {
  track: TrackSummary;
  testID?: string;
}

export function DownloadButton({ track, testID }: DownloadButtonProps) {
  const offline = useOffline();
  const record = offline.downloads.find((d) => d.trackId === track.id) ?? null;
  const status = record?.status ?? 'none';

  const enqueue = () =>
    void offline.downloadTrack(track.id, {
      title: track.title,
      artistName: track.artistName,
      albumTitle: track.albumTitle,
      durationMs: track.durationMs,
    });

  const label = `Download ${track.title}`;

  if (status === 'downloading' || status === 'verifying') {
    const pct =
      record && record.totalBytes
        ? Math.round((record.bytesWritten / record.totalBytes) * 100)
        : null;
    return (
      <Pressable
        onPress={() => void offline.pauseDownload(track.id)}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Pause download of ${track.title}`}
        testID={testID ?? `download-button-${track.id}`}
        style={styles.button}
      >
        {status === 'verifying' ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Text style={styles.progressText}>{pct !== null ? `${pct}%` : '…'}</Text>
        )}
      </Pressable>
    );
  }

  const config: Record<
    string,
    { icon: keyof typeof Ionicons.glyphMap; onPress: () => void; label: string }
  > = {
    none: { icon: 'arrow-down-circle-outline', onPress: enqueue, label },
    queued: {
      icon: 'time-outline',
      onPress: () => void offline.cancelDownload(track.id),
      label: `Cancel download of ${track.title}`,
    },
    paused: {
      icon: 'play-circle-outline',
      onPress: () => void offline.resumeDownload(track.id),
      label: `Resume download of ${track.title}`,
    },
    complete: {
      icon: 'checkmark-circle',
      onPress: () => undefined,
      label: `${track.title} downloaded`,
    },
    failed: {
      icon: 'refresh-circle-outline',
      onPress: () => void offline.retryDownload(track.id),
      label: `Retry download of ${track.title}`,
    },
    stale: {
      icon: 'alert-circle-outline',
      onPress: () => void offline.retryDownload(track.id),
      label: `Re-download ${track.title} (new version available)`,
    },
    unavailable: {
      icon: 'ban-outline',
      onPress: () => undefined,
      label: `${track.title} unavailable offline`,
    },
  };
  const { icon, onPress, label: a11yLabel } = config[status] ?? config.none;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      testID={testID ?? `download-button-${track.id}`}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Ionicons
        name={icon}
        size={fontSize.lg}
        color={
          status === 'complete'
            ? colors.success
            : status === 'failed' || status === 'stale'
              ? colors.warning
              : colors.primary
        }
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 36,
    minHeight: 36,
  },
  pressed: { opacity: 0.6 },
  progressText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
});
