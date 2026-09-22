// Phase 27 — join a collaborative playlist with an invitation token.
//
// The token is pasted in (no deep-link handling exists in the app yet).
// Accepting derives the user from the session — the token alone grants
// nothing. On success the user lands on the joined playlist as an editor.

import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { acceptInvitation, apiErrorMessage } from '../api';
import { useAuth } from '../auth';
import { useOnlineStatus } from '../utils/useOnlineStatus';
import { Button, Screen, TextInput } from '../components';
import { colors, fontSize, fontWeight, spacing } from '../theme';

export function AcceptInvitationScreen() {
  const { api } = useAuth();
  const router = useRouter();
  const online = useOnlineStatus();
  const [token, setToken] = useState('');
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed || accepting || !online) {
      return;
    }
    setAccepting(true);
    setError(null);
    try {
      const detail = await acceptInvitation(api, trimmed);
      router.replace(`/playlist/${detail.id}`);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setAccepting(false);
    }
  }, [accepting, api, online, router, token]);

  return (
    <Screen testID="accept-invitation-screen">
      <Stack.Screen options={{ title: 'Join playlist' }} />
      <View style={styles.content}>
        <Text style={styles.title}>Join a collaborative playlist</Text>
        <Text style={styles.hint}>
          Paste the invitation token shared with you. You'll join as an editor and can add, remove,
          and reorder tracks.
        </Text>
        <TextInput
          label="Invitation token"
          value={token}
          onChangeText={setToken}
          placeholder="Paste token…"
          testID="invitation-token-input"
        />
        {!online ? (
          <Text style={styles.offlineHint} testID="accept-offline-hint">
            You're offline — reconnect to join.
          </Text>
        ) : null}
        {error ? (
          <Text style={styles.error} testID="accept-invitation-error">
            {error}
          </Text>
        ) : null}
        <View style={styles.buttonWrap}>
          <Button
            title={accepting ? 'Joining…' : 'Join playlist'}
            disabled={accepting || token.trim().length === 0 || !online}
            onPress={() => void accept()}
            testID="accept-invitation-button"
          />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.lg },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    marginBottom: spacing.sm,
  },
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.6,
    marginBottom: spacing.lg,
  },
  offlineHint: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
  error: {
    color: colors.error,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
  },
  buttonWrap: { marginTop: spacing.lg },
});
