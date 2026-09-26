// Phase 28 — room lobby: start a room from the current queue, join with
// an invite, or resume the active session.

import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { usePlayback } from '../../playback';
import { useRoom } from '../../rooms';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { apiErrorMessage } from '../../api';

export default function RoomLobbyScreen() {
  const { room, status, joinAsHost, error, clearError } = useRoom();
  const playback = usePlayback();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Already in a room: go straight to it.
  useEffect(() => {
    if (room && (status === 'live' || status === 'connecting' || status === 'reconnecting')) {
      router.replace(`/room/${room.roomId}`);
    }
  }, [room, status]);

  const queueTrackIds = playback.queue.map((t) => t.trackId);

  async function startRoom() {
    if (queueTrackIds.length === 0) {
      setStartError('Play something first — a room needs at least one track.');
      return;
    }
    setStarting(true);
    setStartError(null);
    clearError();
    try {
      await joinAsHost({ trackIds: queueTrackIds });
      // Navigation happens via the effect above once the room lands.
    } catch (err) {
      setStartError(apiErrorMessage(err));
      setStarting(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Ionicons name="people" size={48} color={colors.primary} />
        <Text style={styles.title}>Listen together</Text>
        <Text style={styles.subtitle}>
          Start a private room and everyone hears the same track at the same time. Only people you
          invite can join — rooms never appear in search or recommendations.
        </Text>
      </View>

      {(startError || error) && (
        <Text style={styles.error} testID="room-lobby-error">
          {startError ?? error}
        </Text>
      )}

      <Pressable
        style={[styles.primaryButton, (starting || queueTrackIds.length === 0) && styles.disabled]}
        onPress={startRoom}
        disabled={starting}
        testID="start-room-button"
      >
        {starting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryLabel}>
            {queueTrackIds.length === 0
              ? 'Start a room (play something first)'
              : `Start a room (${queueTrackIds.length} track${queueTrackIds.length === 1 ? '' : 's'})`}
          </Text>
        )}
      </Pressable>

      <Pressable
        style={styles.secondaryButton}
        onPress={() => router.push('/room/join')}
        testID="join-room-button"
      >
        <Ionicons name="ticket-outline" size={20} color={colors.primary} />
        <Text style={styles.secondaryLabel}>Join with an invite</Text>
      </Pressable>

      <Text style={styles.note}>
        Rooms need a connection and an active subscription. The host controls playback; everyone
        else just listens.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.lg,
  },
  hero: {
    alignItems: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    marginTop: spacing.md,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 22,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  disabled: {
    opacity: 0.5,
  },
  primaryLabel: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
  },
  secondaryLabel: {
    color: colors.primary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  error: {
    color: colors.error,
    fontSize: fontSize.sm,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  note: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    marginTop: spacing.xl,
    lineHeight: 20,
  },
});
