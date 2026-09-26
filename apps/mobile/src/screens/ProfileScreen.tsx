// Phase 5 — Profile placeholder: account summary + sign out.
// Phase 18 — adds the subscription section (server-reported state only).
// Phase 19 — adds the store purchase sheet (expo-iap + server verification).
// Phase 20 — adds a Manage subscription entry point to the full
// subscription screen (plans, restore, refresh, store management).

import { useState } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { apiErrorMessage } from '../api';
import { useAuth } from '../auth';
import { Button, Screen, modalAnimationFor, useReducedMotion } from '../components';
import {
  PurchaseSheet,
  SubscriptionCard,
  usePurchaseFlow,
  useSubscription,
} from '../subscriptions';
import { useRoom } from '../rooms';
import { UpdateSettingsCard } from '../updates';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

/** Phase 28 — rooms entry on the profile screen. */
function RoomProfileRow() {
  const { room, status, isHost } = useRoom();
  const active =
    room != null && (status === 'live' || status === 'connecting' || status === 'reconnecting');
  return (
    <View style={styles.roomRow}>
      <View style={styles.roomText}>
        <Text style={styles.roomTitle}>
          {active ? `In a room · ${isHost ? 'HOST' : 'LISTENER'}` : 'Listen together'}
        </Text>
        <Text style={styles.roomSubtitle}>
          {active ? (room?.currentTrack?.title ?? 'Syncing…') : 'Private rooms synced in real time'}
        </Text>
      </View>
      <Button
        title={active ? 'Open room' : 'Rooms'}
        testID="profile-rooms-button"
        variant="secondary"
        onPress={() => {
          if (active && room) {
            router.push(`/room/${room.roomId}`);
          } else {
            router.push('/room');
          }
        }}
      />
    </View>
  );
}

export function ProfileScreen() {
  const { user, api, signOut } = useAuth();
  const subscription = useSubscription(api);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  // Phase 19 — purchase sheet visibility.
  const [purchaseVisible, setPurchaseVisible] = useState(false);
  const reducedMotion = useReducedMotion();
  const purchaseFlow = usePurchaseFlow(api, () => {
    // After the backend verifies a purchase, refresh server state.
    // Entitlement is read from the server, never set locally.
    subscription.retry();
  });

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

  // Show the subscribe button only when there is no active subscription.
  const hasActiveSubscription =
    subscription.data?.subscription != null &&
    (subscription.data.subscription.status === 'ACTIVE' ||
      subscription.data.subscription.status === 'TRIALING' ||
      subscription.data.subscription.status === 'PAST_DUE');

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
      {/* Phase 28 — synchronized listening rooms. */}
      <Text style={styles.sectionHeading}>Listening rooms</Text>
      <RoomProfileRow />
      <Text style={styles.sectionHeading}>Subscription</Text>{' '}
      <SubscriptionCard
        data={subscription.data}
        loading={subscription.state === 'loading' || subscription.state === 'idle'}
        error={subscription.state === 'error' ? subscription.error : null}
        onRetry={subscription.retry}
      />
      {!hasActiveSubscription && subscription.state === 'ready' && (
        <View style={styles.subscribeRow}>
          <Button
            title="Subscribe to Premium"
            testID="subscribe-button"
            onPress={() => setPurchaseVisible(true)}
          />
        </View>
      )}
      {/* Phase 20 — full subscription management (plans, restore, refresh,
          store billing). The screen reads server state; it never decides
          entitlement. */}
      <View style={styles.subscribeRow}>
        <Button
          title="Manage subscription"
          testID="manage-subscription-button"
          variant="secondary"
          accessibilityLabel="Manage subscription"
          accessibilityHint="Opens subscription details, plans, restore, and store billing management"
          onPress={() => router.push('/subscription')}
        />
        <Button
          title="Browse artist stores"
          testID="browse-stores-button"
          variant="secondary"
          onPress={() => router.push('/(commerce)/stores')}
        />
        <Button
          title="My orders"
          testID="my-orders-button"
          variant="secondary"
          onPress={() => router.push('/(commerce)/orders')}
        />
      </View>
      <Modal
        visible={purchaseVisible}
        animationType={modalAnimationFor(reducedMotion)}
        presentationStyle="pageSheet"
        onRequestClose={() => setPurchaseVisible(false)}
      >
        <Screen testID="purchase-modal" modal>
          <PurchaseSheet flow={purchaseFlow} onClose={() => setPurchaseVisible(false)} />
        </Screen>
      </Modal>
      <View style={styles.signOut}>
        {/* Release tooling — over-the-air updates (JS-only; native changes
            still need a store build). */}
        <Text style={styles.sectionHeading}>App updates</Text>
        <UpdateSettingsCard />
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
  subscribeRow: { marginTop: spacing.md },
  roomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  roomText: {
    flex: 1,
    marginRight: spacing.md,
  },
  roomTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  roomSubtitle: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
  },
});
