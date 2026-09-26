// Phase 28 — the active room screen.
//
// Reads the shared engine (via usePlayback) for the synced position and
// the room session (via useRoom) for authoritative state. The host gets
// transport controls; participants get a read-only view. No second player,
// no room state duplicated into local state.

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { usePlayback } from '../../playback';
import { useRoom } from '../../rooms';
import { ArtworkImage } from '../../catalog/components/ArtworkImage';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { apiErrorMessage } from '../../api';
import { formatDuration } from '../../catalog/format';

/** Re-render every second so the progress bar advances while playing. */
function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

function StatusBanner() {
  const { status, resync, error } = useRoom();
  if (status === 'reconnecting' || status === 'connecting' || status === 'joining') {
    return (
      <View style={[styles.banner, styles.bannerInfo]} testID="room-reconnecting">
        <ActivityIndicator size="small" color={colors.primary} />
        <Text style={styles.bannerText}>
          {status === 'joining' ? 'Joining room…' : 'Reconnecting…'}
        </Text>
        <Pressable onPress={() => void resync()} testID="room-resync">
          <Text style={styles.bannerAction}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  if (status === 'ended') {
    return (
      <View style={[styles.banner, styles.bannerEnded]} testID="room-ended">
        <Ionicons name="flag-outline" size={16} color={colors.textMuted} />
        <Text style={styles.bannerText}>This room has ended.</Text>
      </View>
    );
  }
  if (status === 'error' && error) {
    return (
      <View style={[styles.banner, styles.bannerError]} testID="room-error">
        <Text style={styles.bannerText}>{error}</Text>
      </View>
    );
  }
  return null;
}

function HostControls() {
  const { room, status, hostPlay, hostPause, hostNext, hostPrevious } = useRoom();
  const playback = usePlayback();
  const live = status === 'live';
  const playing = room?.playbackState === 'PLAYING';
  const canNav = (room?.queue.length ?? 0) > 1;

  return (
    <View style={styles.controls}>
      <Pressable
        onPress={hostPrevious}
        disabled={!live || !canNav}
        accessibilityLabel="Previous track"
        testID="room-previous"
        style={styles.controlButton}
      >
        <Ionicons
          name="play-skip-back"
          size={32}
          color={live && canNav ? colors.text : colors.textFaint}
        />
      </Pressable>
      <Pressable
        onPress={playing ? hostPause : hostPlay}
        disabled={!live}
        accessibilityLabel={playing ? 'Pause room' : 'Play room'}
        testID={playing ? 'room-pause' : 'room-play'}
        style={[styles.controlButton, styles.playButton]}
      >
        {playback.state === 'loading' || playback.state === 'buffering' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Ionicons name={playing ? 'pause' : 'play'} size={36} color="#fff" />
        )}
      </Pressable>
      <Pressable
        onPress={hostNext}
        disabled={!live || !canNav}
        accessibilityLabel="Next track"
        testID="room-next"
        style={styles.controlButton}
      >
        <Ionicons
          name="play-skip-forward"
          size={32}
          color={live && canNav ? colors.text : colors.textFaint}
        />
      </Pressable>
    </View>
  );
}

export default function RoomScreen() {
  const { room, members, isHost, status, leave, endRoom, createInvitation } = useRoom();
  const playback = usePlayback();
  const [inviting, setInviting] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useNow(1000, room?.playbackState === 'PLAYING' && status === 'live');

  // Landed here without a session (deep link, stale nav): bounce to lobby.
  useEffect(() => {
    if (!room && (status === 'idle' || status === 'error')) {
      router.replace('/room');
    }
  }, [room, status]);

  const track = room?.currentTrack ?? null;
  const durationMs = playback.durationMs > 0 ? playback.durationMs : (track?.durationMs ?? 0);
  const positionMs = Math.min(
    playback.positionMs,
    durationMs > 0 ? durationMs : playback.positionMs,
  );

  const hostName = useMemo(
    () => members.find((m) => m.role === 'HOST')?.displayName ?? 'the host',
    [members],
  );

  async function invite() {
    setInviting(true);
    try {
      const invitation = await createInvitation();
      await Share.share({
        message:
          `Join my Waveform listening room!\n` +
          `Room: ${room?.roomId}\n` +
          `Token: ${invitation.token}\n\n` +
          `The token is single-use and expires in 7 days.`,
      });
    } catch (err) {
      Alert.alert('Invite failed', apiErrorMessage(err));
    } finally {
      setInviting(false);
    }
  }

  async function doLeave() {
    setLeaving(true);
    try {
      await leave();
    } finally {
      router.replace('/room');
    }
  }

  function confirmEnd() {
    Alert.alert('End room?', 'Everyone listening will be disconnected.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'End room',
        style: 'destructive',
        onPress: () => {
          void endRoom().catch((err: unknown) => {
            Alert.alert('Could not end the room', apiErrorMessage(err));
          });
        },
      },
    ]);
  }

  if (!room) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBanner />

      <View style={styles.nowPlaying}>
        <ArtworkImage
          uri={track?.artworkUrl}
          title={track?.title ?? 'No track'}
          seed={track?.id ?? 'room'}
          size={176}
          testID="room-artwork"
        />
        <Text style={styles.trackTitle} numberOfLines={2} testID="room-track-title">
          {track?.title ?? 'No track yet'}
        </Text>
        <Text style={styles.trackArtist} numberOfLines={1}>
          {track?.artistName ?? ''}
        </Text>
        <View style={styles.roleRow}>
          <View style={[styles.roleBadge, isHost ? styles.hostBadge : styles.guestBadge]}>
            <Text style={styles.roleText}>{isHost ? 'HOST' : 'LISTENER'}</Text>
          </View>
          {!isHost && (
            <Text style={styles.hostedBy} numberOfLines={1}>
              Hosted by {hostName}
            </Text>
          )}
          {isHost && (
            <Text style={styles.hostedBy} numberOfLines={1}>
              {members.length} listening
            </Text>
          )}
        </View>
      </View>

      {/* Progress: the engine position is the drift-corrected room position. */}
      <View style={styles.progressRow}>
        <Text style={styles.time}>{formatDuration(positionMs)}</Text>
        <View style={styles.progressBar} testID="room-progress">
          <View
            style={[
              styles.progressFill,
              { width: `${durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0}%` },
            ]}
          />
        </View>
        <Text style={styles.time}>{formatDuration(durationMs)}</Text>
      </View>
      {isHost && <Text style={styles.seekHint}>Drag on the player screen to seek everyone</Text>}

      {isHost ? (
        <HostControls />
      ) : (
        <View style={styles.participantNote} testID="room-participant-note">
          <Ionicons name="headset-outline" size={18} color={colors.textMuted} />
          <Text style={styles.participantText}>
            Sit back — {hostName} controls playback for everyone.
          </Text>
        </View>
      )}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Up next</Text>
        {isHost && status === 'live' && (
          <Pressable onPress={invite} disabled={inviting} testID="room-invite">
            <Text style={styles.inviteAction}>{inviting ? 'Creating…' : '+ Invite'}</Text>
          </Pressable>
        )}
      </View>

      <FlatList
        data={room.queue}
        keyExtractor={(item) => item.id}
        style={styles.list}
        renderItem={({ item, index }) => (
          <View style={[styles.queueRow, index === room.queueIndex && styles.queueRowCurrent]}>
            <Text style={styles.queueIndex}>{index + 1}</Text>
            <View style={styles.queueText}>
              <Text style={styles.queueTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.queueArtist} numberOfLines={1}>
                {item.artistName}
              </Text>
            </View>
            {index === room.queueIndex && (
              <Ionicons
                name={room.playbackState === 'PLAYING' ? 'volume-high' : 'volume-mute'}
                size={16}
                color={colors.primary}
              />
            )}
          </View>
        )}
        ListHeaderComponent={
          <View style={styles.membersBlock}>
            <Text style={styles.sectionTitle}>In this room ({members.length})</Text>
            {members.map((member) => (
              <View key={member.userId} style={styles.memberRow}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {member.displayName.charAt(0).toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.memberName} numberOfLines={1}>
                  {member.displayName}
                </Text>
                {member.role === 'HOST' && (
                  <Ionicons name="star" size={14} color={colors.primary} />
                )}
              </View>
            ))}
          </View>
        }
      />

      <View style={styles.footer}>
        {isHost && status !== 'ended' ? (
          <Pressable style={styles.dangerButton} onPress={confirmEnd} testID="room-end">
            <Text style={styles.dangerLabel}>End room for everyone</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={styles.leaveButton}
          onPress={() => void doLeave()}
          disabled={leaving}
          testID="room-leave"
        >
          <Text style={styles.leaveLabel}>{leaving ? 'Leaving…' : 'Leave room'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  centered: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  bannerInfo: {
    backgroundColor: colors.surfaceElevated,
  },
  bannerEnded: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bannerError: {
    backgroundColor: colors.errorMuted,
  },
  bannerText: {
    color: colors.text,
    fontSize: fontSize.sm,
    flex: 1,
  },
  bannerAction: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  nowPlaying: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  trackTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  trackArtist: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    marginTop: 2,
  },
  roleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.sm,
  },
  roleBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  hostBadge: {
    backgroundColor: colors.primary,
  },
  guestBadge: {
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
  },
  roleText: {
    color: '#fff',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  hostedBy: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progressBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceElevated,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    backgroundColor: colors.primary,
  },
  time: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    minWidth: 40,
    textAlign: 'center',
  },
  seekHint: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    textAlign: 'center',
    marginTop: 4,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
    marginVertical: spacing.md,
  },
  controlButton: {
    padding: spacing.sm,
  },
  playButton: {
    backgroundColor: colors.primary,
    borderRadius: 36,
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  participantNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginVertical: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: 10,
  },
  participantText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  inviteAction: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  list: {
    flex: 1,
  },
  membersBlock: {
    marginBottom: spacing.md,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.text,
    fontWeight: fontWeight.semibold,
  },
  memberName: {
    color: colors.text,
    fontSize: fontSize.md,
    flex: 1,
  },
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  queueRowCurrent: {
    backgroundColor: colors.surface,
  },
  queueIndex: {
    color: colors.textFaint,
    fontSize: fontSize.sm,
    width: 24,
    textAlign: 'center',
  },
  queueText: {
    flex: 1,
  },
  queueTitle: {
    color: colors.text,
    fontSize: fontSize.md,
  },
  queueArtist: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  footer: {
    gap: 8,
    marginTop: spacing.md,
  },
  dangerButton: {
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  dangerLabel: {
    color: colors.error,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  leaveButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  leaveLabel: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
});
