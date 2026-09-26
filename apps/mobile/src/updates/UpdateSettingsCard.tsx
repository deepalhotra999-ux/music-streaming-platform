// Release tooling — "App updates" card for the profile screen.
//
// Shows the currently running OTA update (channel, update id, runtime
// version), the check state, and the actions: manual "Check for updates" and
// "Restart to apply" when a download is ready. In development builds the card
// explains that OTA is unavailable instead of erroring.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';
import { useAppUpdates, type UpdateCheckState } from './useAppUpdates';

function statusText(state: UpdateCheckState): string {
  switch (state) {
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return 'Downloading update…';
    case 'ready':
      return 'Update downloaded. Restart to apply it.';
    case 'up-to-date':
      return 'You are on the latest version.';
    case 'error':
      return 'The update check failed.';
    case 'unavailable':
      return 'Over-the-air updates are unavailable in this build (development).';
  }
}

export function UpdateSettingsCard() {
  const { state, error, info, checkNow, applyUpdate } = useAppUpdates();
  const busy = state === 'checking' || state === 'downloading';
  const shortId = info.updateId ? info.updateId.slice(0, 8) : 'embedded';

  return (
    <View style={styles.card} testID="app-updates-card">
      <View style={styles.row}>
        <View style={styles.text}>
          <Text style={styles.title} testID="app-updates-status">
            {statusText(state)}
          </Text>
          <Text style={styles.subtitle}>
            {`Channel ${info.channel ?? '—'} · ${shortId} · runtime ${info.runtimeVersion ?? '—'}`}
          </Text>
          {error ? (
            <Text style={styles.error} testID="app-updates-error">
              {error}
            </Text>
          ) : null}
        </View>
        {busy ? <ActivityIndicator testID="app-updates-spinner" /> : null}
      </View>
      {state !== 'unavailable' ? (
        <View style={styles.actions}>
          <Button
            title="Check for updates"
            testID="check-updates-button"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              void checkNow();
            }}
          />
          {state === 'ready' ? (
            <View style={styles.applyRow}>
              <Button
                title="Restart to apply update"
                testID="apply-update-button"
                onPress={() => {
                  void applyUpdate();
                }}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: {
    flex: 1,
    marginRight: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
  error: {
    color: colors.error,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
  },
  actions: {
    marginTop: spacing.md,
  },
  applyRow: {
    marginTop: spacing.sm,
  },
});
