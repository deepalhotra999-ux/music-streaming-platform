// Phase 25 — Downloads screen: every offline download with its state,
// storage usage, and actions. Playable state is the SecureStore gate —
// what this screen shows as "Downloaded" always passed it.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { TrackSummary } from '../api';
import { Button, EmptyState, Screen } from '../components';
import { useQueueActions } from '../player';
import { colors, fontSize, fontWeight, spacing } from '../theme';
import { useOffline } from '../offline/OfflineProvider';
import { queuedEventCount } from '../offline/eventQueue';
import { formatBytes } from '../offline/format';
import type { DownloadRecord, DownloadStatus } from '../offline/types';

const STATUS_LABEL: Record<DownloadStatus, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  paused: 'Paused',
  verifying: 'Verifying',
  complete: 'Downloaded',
  failed: 'Failed',
  stale: 'New version available',
  unavailable: 'Unavailable',
};

function statusColor(status: DownloadStatus): string {
  switch (status) {
    case 'complete':
      return colors.success;
    case 'failed':
    case 'unavailable':
      return colors.warning;
    case 'stale':
      return colors.warning;
    default:
      return colors.primary;
  }
}

function RowAction({
  label,
  onPress,
  variant = 'secondary',
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <Text style={[styles.actionText, variant === 'primary' && styles.actionTextPrimary]}>
        {label}
      </Text>
    </Pressable>
  );
}

function DownloadRow({ record }: { record: DownloadRecord }) {
  const offline = useOffline();
  const { playTracks } = useQueueActions();
  const pct =
    record.totalBytes && record.totalBytes > 0
      ? Math.min(100, Math.round((record.bytesWritten / record.totalBytes) * 100))
      : null;

  const toTrack = (): TrackSummary => ({
    id: record.trackId,
    title: record.title,
    durationMs: record.durationMs,
    status: 'published',
    artistId: '',
    artistName: record.artistName,
    albumId: null,
    albumTitle: record.albumTitle,
  });

  return (
    <View style={styles.row} testID={`download-row-${record.trackId}`}>
      <View style={styles.rowMain}>
        <Text style={styles.title} numberOfLines={1}>
          {record.title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {record.artistName}
        </Text>
        <View style={styles.statusRow}>
          <View style={[styles.badge, { borderColor: statusColor(record.status) }]}>
            <Text style={[styles.badgeText, { color: statusColor(record.status) }]}>
              {STATUS_LABEL[record.status]}
            </Text>
          </View>
          {(record.status === 'downloading' || record.status === 'paused') && (
            <Text style={styles.meta}>
              {formatBytes(record.bytesWritten)}
              {record.totalBytes ? ` of ${formatBytes(record.totalBytes)}` : ''}
              {pct !== null ? ` · ${pct}%` : ''}
            </Text>
          )}
          {record.status === 'complete' && (
            <Text style={styles.meta}>{formatBytes(record.totalBytes)}</Text>
          )}
        </View>
        {record.status === 'downloading' && pct !== null && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` }]} />
          </View>
        )}
        {record.error && (
          <Text style={styles.error} numberOfLines={2}>
            {record.error}
          </Text>
        )}
        {record.unavailableReason && (
          <Text style={styles.error} numberOfLines={2}>
            {reasonLabel(record.unavailableReason)}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        {record.status === 'downloading' && (
          <>
            <RowAction
              label="Pause"
              onPress={() => void offline.pauseDownload(record.trackId)}
              testID={`download-pause-${record.trackId}`}
            />
            <RowAction
              label="Cancel"
              onPress={() => void offline.cancelDownload(record.trackId)}
              testID={`download-cancel-${record.trackId}`}
            />
          </>
        )}
        {record.status === 'paused' && (
          <>
            <RowAction
              label="Resume"
              variant="primary"
              onPress={() => void offline.resumeDownload(record.trackId)}
              testID={`download-resume-${record.trackId}`}
            />
            <RowAction
              label="Cancel"
              onPress={() => void offline.cancelDownload(record.trackId)}
              testID={`download-cancel-${record.trackId}`}
            />
          </>
        )}
        {record.status === 'queued' && (
          <RowAction
            label="Cancel"
            onPress={() => void offline.cancelDownload(record.trackId)}
            testID={`download-cancel-${record.trackId}`}
          />
        )}
        {(record.status === 'failed' || record.status === 'stale') && (
          <>
            <RowAction
              label={record.status === 'stale' ? 'Re-download' : 'Retry'}
              variant="primary"
              onPress={() => void offline.retryDownload(record.trackId)}
              testID={`download-retry-${record.trackId}`}
            />
            <RowAction
              label="Remove"
              onPress={() => void offline.cancelDownload(record.trackId)}
              testID={`download-remove-${record.trackId}`}
            />
          </>
        )}
        {record.status === 'complete' && (
          <>
            <RowAction
              label="Play"
              variant="primary"
              onPress={() => void playTracks([toTrack()], 0)}
              testID={`download-play-${record.trackId}`}
            />
            <RowAction
              label="Remove"
              onPress={() => void offline.removeDownload(record.trackId)}
              testID={`download-remove-${record.trackId}`}
            />
          </>
        )}
        {record.status === 'unavailable' && (
          <RowAction
            label="Remove"
            onPress={() => void offline.cancelDownload(record.trackId)}
            testID={`download-remove-${record.trackId}`}
          />
        )}
        {record.status === 'verifying' && <ActivityIndicator size="small" color={colors.primary} />}
      </View>
    </View>
  );
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'revoked':
      return 'This download was revoked and removed.';
    case 'entitlement_lost':
      return 'Your subscription no longer includes downloads. Removed.';
    case 'track_unavailable':
      return 'This track is no longer available. Removed.';
    case 'version_mismatch':
      return 'A new version of this track was published. Re-download to update.';
    case 'expired':
      return 'The offline authorization expired. Removed.';
    default:
      return reason;
  }
}

export function DownloadsScreen() {
  const offline = useOffline();
  const [refreshing, setRefreshing] = useState(false);
  const [pendingEvents, setPendingEvents] = useState(0);
  const [revalidating, setRevalidating] = useState(false);

  const loadPending = useCallback(async () => {
    try {
      setPendingEvents(await queuedEventCount());
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending, offline.downloads]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void offline
      .refresh()
      .then(() => loadPending())
      .finally(() => setRefreshing(false));
  }, [offline, loadPending]);

  const onRevalidate = useCallback(() => {
    setRevalidating(true);
    void offline
      .revalidateNow()
      .catch(() => undefined)
      .finally(() => setRevalidating(false));
  }, [offline]);

  return (
    <Screen scrollable={false} padded={false} edges={['bottom']} testID="downloads-screen">
      <View style={styles.header}>
        <View style={styles.storageRow}>
          <Ionicons name="phone-portrait-outline" size={fontSize.lg} color={colors.textMuted} />
          <Text style={styles.storageText} testID="downloads-storage">
            {offline.usedBytes === null
              ? 'Measuring storage…'
              : `${formatBytes(offline.usedBytes)} used`}
          </Text>
        </View>
        {pendingEvents > 0 && (
          <Text style={styles.pendingText} testID="downloads-pending-events">
            {pendingEvents} play {pendingEvents === 1 ? 'event' : 'events'} waiting to sync
          </Text>
        )}
        <Button
          title={revalidating ? 'Checking…' : 'Check for updates'}
          variant="secondary"
          size="md"
          onPress={onRevalidate}
          disabled={revalidating}
          testID="downloads-revalidate"
        />
      </View>
      <FlatList
        data={offline.downloads}
        keyExtractor={(item) => item.trackId}
        renderItem={({ item }) => <DownloadRow record={item} />}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          <EmptyState
            title="No downloads yet"
            message="Download tracks to listen offline. They play with no network and no streaming session."
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  storageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  storageText: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  pendingText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    flexGrow: 1,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  rowMain: { flex: 1, gap: 4 },
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 2,
  },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  meta: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: spacing.xs,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  error: {
    color: colors.warning,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  actions: {
    justifyContent: 'center',
    gap: spacing.xs,
    alignItems: 'flex-end',
  },
  action: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
  },
  pressed: { opacity: 0.6 },
  actionText: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  actionTextPrimary: { color: colors.primary },
});
