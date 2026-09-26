// Phase 28 — join a room with an invitation.
//
// Accepts either a pasted invite block (room id + token extracted with a
// tolerant parse) or the two values typed separately. The raw token is
// single-use: a successful join consumes it.

import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useRoom } from '../../rooms';
import { parseInviteText } from '../../rooms/invite';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { apiErrorMessage } from '../../api';

export default function JoinRoomScreen() {
  const { joinWithToken, status } = useRoom();
  const [roomId, setRoomId] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setError(null);
    let id = roomId.trim();
    let tok = token.trim();
    if ((!id || !tok) && (roomId || token)) {
      // Try the tolerant paste parse over whatever was entered.
      const parsed = parseInviteText(`${roomId}\n${token}`);
      if (parsed) {
        id = parsed.roomId;
        tok = parsed.token;
      }
    }
    if (!id || !tok) {
      setError('Enter the room ID and invite token from your host.');
      return;
    }
    setBusy(true);
    try {
      await joinWithToken(id, tok);
      router.replace(`/room/${id}`);
    } catch (err) {
      // Wrong, used, revoked, or expired tokens all surface as a generic
      // failure: the server never distinguishes them.
      setError(apiErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Join a listening room</Text>
      <Text style={styles.hint}>
        Paste the invite your host shared, or enter the room ID and token separately.
      </Text>

      <Text style={styles.label}>Room ID</Text>
      <TextInput
        style={styles.input}
        value={roomId}
        onChangeText={setRoomId}
        placeholder="00000000-0000-0000-0000-000000000000"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        testID="join-room-id"
      />

      <Text style={styles.label}>Invite token</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="Paste the invite token"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        testID="join-room-token"
      />

      {error && (
        <Text style={styles.error} testID="join-error">
          {error}
        </Text>
      )}

      <Pressable
        style={[styles.button, busy && styles.disabled]}
        onPress={join}
        disabled={busy}
        testID="join-submit"
      >
        {busy || status === 'joining' ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonLabel}>Join room</Text>
        )}
      </Pressable>

      <Text style={styles.note}>
        Invites are single-use and expire after 7 days. Joining never changes your subscription —
        you still need one to listen.
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
  heading: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.sm,
  },
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    marginBottom: spacing.lg,
    lineHeight: 22,
  },
  label: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    marginBottom: spacing.sm,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    fontSize: fontSize.md,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  disabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    color: '#fff',
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  error: {
    color: colors.error,
    fontSize: fontSize.sm,
    marginTop: spacing.md,
  },
  note: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.xl,
    lineHeight: 20,
  },
});
