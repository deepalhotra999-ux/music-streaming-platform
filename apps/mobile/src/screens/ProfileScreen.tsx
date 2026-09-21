// Phase 5 — Profile placeholder: account summary + sign out.
// Phase 18 — adds the subscription section (server-reported state only).

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { apiErrorMessage } from '../api';
import { useAuth } from '../auth';
import { Button, Screen } from '../components';
import { SubscriptionCard, useSubscription } from '../subscriptions';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

export function ProfileScreen() {
  const { user, api, signOut } = useAuth();
  const subscription = useSubscription(api);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const handleSignOut = async () => {
    setSignOutError(null);
    setSigningOut(true);
    try {
      await signOut();
      // Navigation is driven by auth state; nothing to do here on success.
    } catch (error) {
      setSignOutError(apiErrorMessage(error));
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <Screen testID="profile-screen">
      <Text style={styles.heading}>Profile</Text>

      <View style={styles.card} testID="profile-card">
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {(user?.displayName ?? '?').slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <Text style={styles.displayName}>{user?.displayName ?? '—'}</Text>
        <Text style={styles.email}>{user?.email ?? '—'}</Text>
        <View style={styles.roleBadge}>
          <Text style={styles.roleText}>{user?.role ?? '—'}</Text>
        </View>
      </View>

      {signOutError ? (
        <View style={styles.banner} testID="signout-error-banner">
          <Text style={styles.bannerText}>{signOutError}</Text>
        </View>
      ) : null}

      <Text style={styles.sectionHeading}>Subscription</Text>
      <SubscriptionCard
        data={subscription.data}
        loading={subscription.state === 'loading' || subscription.state === 'idle'}
        error={subscription.state === 'error' ? subscription.error : null}
        onRetry={subscription.retry}
      />

      <View style={styles.signOut}>
        <Button
          title="Sign out"
          testID="signout-button"
          onPress={handleSignOut}
          loading={signingOut}
          variant="secondary"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: {
    color: colors.text,
    fontSize: fontSize.xxl,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.xl,
    alignItems: 'center',
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  avatarText: { color: colors.onPrimary, fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  displayName: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  email: { color: colors.textMuted, fontSize: fontSize.sm, marginTop: spacing.xs },
  roleBadge: {
    marginTop: spacing.md,
    backgroundColor: colors.surfaceElevated,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  roleText: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    letterSpacing: 1,
  },
  banner: {
    backgroundColor: colors.errorMuted,
    borderRadius: radii.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  bannerText: { color: colors.error, fontSize: fontSize.sm },
  sectionHeading: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  signOut: { marginTop: spacing.xl },
});
