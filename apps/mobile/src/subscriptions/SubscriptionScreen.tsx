// Phase 20 — subscription management screen.
//
// A complete user-facing subscription experience on top of the Phase 18/19
// infrastructure. The backend remains authoritative for subscription state
// and entitlement — this screen only displays what the server reports and
// sends store purchase tokens to the backend for verification.
//
// Sections:
//   - Current subscription: status, plan, billing period, renewal/expiry,
//     trial info, locked-state messaging when not entitled.
//   - Available plans: server-configured products with store prices
//     (never invented; from the product endpoint + expo-iap details).
//   - Actions: subscribe, restore purchases, refresh status, manage
//     subscription (deep-links to the official store UI).
//
// Purchase recovery runs once on mount: any store-side purchases are
// reconciled with the backend silently. The app never assumes entitlement
// from local purchase state.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  apiErrorMessage,
  type ApiClient,
  type StoreProduct,
  type Subscription,
  type SubscriptionStatus,
} from '../api';
import { Button, Screen } from '../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';
import { openStoreSubscriptionManagement } from './manageSubscription';
import { usePurchaseFlow } from './purchases';
import { useSubscription } from './useSubscription';

// --- Status presentation -------------------------------------------------

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: 'Active',
  TRIALING: 'Trial',
  PAST_DUE: 'Past due',
  CANCELED: 'Canceled',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

/** Non-color-only status indicator: icon + label for every state. */
function statusIcon(status: SubscriptionStatus): keyof typeof Ionicons.glyphMap {
  switch (status) {
    case 'ACTIVE':
      return 'checkmark-circle';
    case 'TRIALING':
      return 'time-outline';
    case 'PAST_DUE':
      return 'warning-outline';
    case 'CANCELED':
      return 'remove-circle-outline';
    case 'EXPIRED':
      return 'hourglass-outline';
    case 'REVOKED':
      return 'ban-outline';
  }
}

function statusColor(status: SubscriptionStatus): string {
  switch (status) {
    case 'ACTIVE':
    case 'TRIALING':
      return colors.success;
    case 'PAST_DUE':
    case 'CANCELED':
      return colors.warning;
    case 'EXPIRED':
    case 'REVOKED':
      return colors.error;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function providerLabel(provider: Subscription['provider']): string {
  switch (provider) {
    case 'APPLE':
      return 'App Store';
    case 'GOOGLE':
      return 'Google Play';
    case 'DEV':
      return 'Development';
  }
}

// --- Props -----------------------------------------------------------------

interface SubscriptionScreenProps {
  api: ApiClient | null;
  testID?: string;
}

// --- Screen ----------------------------------------------------------------

export function SubscriptionScreen({
  api,
  testID = 'subscription-screen',
}: SubscriptionScreenProps) {
  const subscription = useSubscription(api);
  const [recovered, setRecovered] = useState(false);
  const [manageError, setManageError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);

  const purchaseFlow = usePurchaseFlow(api, () => {
    // After the backend verifies a purchase, refresh server state.
    // Entitlement is read from the server, never set locally.
    subscription.retry();
  });

  // Phase 20 — purchase recovery on screen mount. Reconciles any
  // store-side purchases with the backend silently; the normal case
  // (nothing to recover) shows no error.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const didRecover = await purchaseFlow.recoverPending();
      if (!cancelled && didRecover) {
        setRecovered(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount.
  }, []);

  const handleManage = useCallback(async () => {
    setManageError(null);
    setManaging(true);
    try {
      const sub = subscription.data?.subscription;
      const storeProductId =
        Platform.OS === 'ios'
          ? sub?.provider === 'APPLE'
            ? (purchaseFlow.products?.find((p) => p.planCode === sub.planId)?.appleProductId ??
              null)
            : null
          : sub?.provider === 'GOOGLE'
            ? (purchaseFlow.products?.find((p) => p.planCode === sub.planId)?.googleProductId ??
              null)
            : null;
      await openStoreSubscriptionManagement(storeProductId);
      // We do NOT claim anything changed — the user manages billing in the
      // store UI. Refresh server state when they return; the backend is
      // authoritative.
      subscription.retry();
    } catch (err) {
      setManageError(apiErrorMessage(err));
    } finally {
      setManaging(false);
    }
  }, [subscription, purchaseFlow.products]);

  const handleRefresh = useCallback(() => {
    setManageError(null);
    subscription.retry();
    purchaseFlow.load();
  }, [subscription, purchaseFlow]);

  if (!api) {
    return (
      <Screen testID={testID}>
        <View style={styles.center} accessibilityRole="alert">
          <Ionicons name="person-circle-outline" size={40} color={colors.textMuted} />
          <Text style={styles.title}>Sign in required</Text>
          <Text style={styles.muted}>Sign in to view and manage your subscription.</Text>
        </View>
      </Screen>
    );
  }

  const { data } = subscription;
  const sub = data?.subscription ?? null;
  const entitlement = data?.entitlement ?? null;
  const flowState = purchaseFlow.state;

  return (
    <Screen testID={testID}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        accessibilityLabel="Subscription management"
      >
        <Text style={styles.heading} accessibilityRole="header">
          Subscription
        </Text>

        {recovered && (
          <View
            style={styles.notice}
            testID="recovery-notice"
            accessibilityRole="alert"
            accessibilityLabel="Recovered purchases"
          >
            <Ionicons name="checkmark-circle-outline" size={20} color={colors.success} />
            <Text style={styles.noticeText}>
              Recovered pending purchases and synced with the server.
            </Text>
          </View>
        )}

        <CurrentSubscriptionSection
          loading={subscription.state === 'loading' || subscription.state === 'idle'}
          error={subscription.state === 'error' ? subscription.error : null}
          onRetry={subscription.retry}
          subscription={sub}
          entitled={entitlement?.entitled ?? false}
        />

        {/* Purchase flow states: pending / verifying / failed / canceled */}
        {flowState === 'purchasing' || flowState === 'verifying' ? (
          <View
            style={styles.card}
            testID="purchase-pending"
            accessibilityRole="alert"
            accessibilityLabel={
              flowState === 'verifying' ? 'Verifying purchase with server' : 'Purchase in progress'
            }
          >
            <Text style={styles.title}>
              {flowState === 'verifying' ? 'Verifying purchase…' : 'Completing purchase…'}
            </Text>
            <Text style={styles.muted}>
              {flowState === 'verifying'
                ? 'The store confirmed your purchase. We\u2019re verifying it with our server — playback unlocks only after verification completes.'
                : 'Follow the store prompts to complete your purchase.'}
            </Text>
          </View>
        ) : null}

        {flowState === 'failed' && purchaseFlow.error ? (
          <View
            style={styles.card}
            testID="purchase-failed"
            accessibilityRole="alert"
            accessibilityLabel={`Purchase failed: ${purchaseFlow.error}`}
          >
            <View style={styles.row}>
              <Ionicons name="alert-circle-outline" size={22} color={colors.error} />
              <Text style={styles.title}>Purchase didn\u2019t go through</Text>
            </View>
            <Text style={styles.muted}>{purchaseFlow.error}</Text>
            <Text style={styles.muted}>
              Your server subscription is unchanged. You can try again or restore purchases.
            </Text>
            <Button
              title="Try again"
              testID="purchase-retry"
              variant="secondary"
              onPress={() => purchaseFlow.reset()}
            />
          </View>
        ) : null}

        {flowState === 'canceled' ? (
          <View
            style={styles.card}
            testID="purchase-canceled"
            accessibilityLabel="Purchase canceled"
          >
            <View style={styles.row}>
              <Ionicons name="remove-circle-outline" size={22} color={colors.textMuted} />
              <Text style={styles.title}>Purchase canceled</Text>
            </View>
            <Text style={styles.muted}>
              You canceled the purchase. No charge was made and nothing changed on your account.
            </Text>
            <Button
              title="Dismiss"
              testID="purchase-canceled-dismiss"
              variant="secondary"
              onPress={() => purchaseFlow.reset()}
            />
          </View>
        ) : null}

        {flowState === 'success' ? (
          <View
            style={styles.card}
            testID="purchase-success"
            accessibilityRole="alert"
            accessibilityLabel="Purchase verified"
          >
            <View style={styles.row}>
              <Ionicons name="checkmark-circle" size={22} color={colors.success} />
              <Text style={styles.title}>Purchase verified</Text>
            </View>
            <Text style={styles.muted}>
              Your subscription is now active on the server. Enjoy Premium playback.
            </Text>
            <Button
              title="Done"
              testID="purchase-success-dismiss"
              variant="secondary"
              onPress={() => purchaseFlow.reset()}
            />
          </View>
        ) : null}

        <PlansSection
          products={purchaseFlow.products}
          storeDetails={purchaseFlow.storeDetails}
          productsState={flowState}
          productsError={purchaseFlow.error}
          onLoad={purchaseFlow.load}
          onPurchase={purchaseFlow.purchase}
          hasSubscription={sub != null}
          currentPlanCode={sub?.planId ?? null}
        />

        <View style={styles.actions}>
          <Button
            title="Restore purchases"
            testID="restore-purchases"
            variant="secondary"
            accessibilityLabel="Restore purchases"
            accessibilityHint="Checks the store for previous purchases and syncs them with the server"
            onPress={() => purchaseFlow.restore()}
            loading={flowState === 'restoring'}
          />
          <Button
            title="Refresh status"
            testID="refresh-status"
            variant="secondary"
            accessibilityLabel="Refresh subscription status"
            accessibilityHint="Reloads your subscription state from the server"
            onPress={handleRefresh}
          />
          {sub && (sub.provider === 'APPLE' || sub.provider === 'GOOGLE') ? (
            <Button
              title="Manage subscription"
              testID="manage-subscription"
              variant="secondary"
              accessibilityLabel="Manage subscription"
              accessibilityHint={`Opens ${providerLabel(sub.provider)} subscription management. Cancellations and plan changes are handled by the store.`}
              onPress={() => void handleManage()}
              loading={managing}
            />
          ) : null}
        </View>

        {manageError ? (
          <View
            style={styles.card}
            testID="manage-error"
            accessibilityRole="alert"
            accessibilityLabel={`Could not open subscription management: ${manageError}`}
          >
            <Text style={styles.errorText}>Couldn\u2019t open subscription management.</Text>
            <Text style={styles.muted}>{manageError}</Text>
          </View>
        ) : null}

        <View style={styles.help} accessibilityLabel="Subscription help">
          <Text style={styles.helpTitle}>How billing works</Text>
          <Text style={styles.muted}>
            Subscriptions are billed by the{' '}
            {sub ? providerLabel(sub.provider) : 'App Store or Google Play'}. Cancellations, plan
            changes, and payment updates are managed in the store — not in this app. Changes can
            take a few minutes to appear here; use Refresh status after managing your subscription.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

// --- Current subscription --------------------------------------------------

interface CurrentSubscriptionSectionProps {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  subscription: Subscription | null;
  entitled: boolean;
}

function CurrentSubscriptionSection({
  loading,
  error,
  onRetry,
  subscription,
  entitled,
}: CurrentSubscriptionSectionProps) {
  if (loading) {
    return (
      <View style={styles.card} testID="current-subscription-loading">
        <Text style={styles.muted}>Checking subscription…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View
        style={styles.card}
        testID="current-subscription-error"
        accessibilityRole="alert"
        accessibilityLabel={`Could not load subscription: ${error}`}
      >
        <Text style={styles.errorText}>Couldn\u2019t load subscription.</Text>
        <Text style={styles.muted}>{error}</Text>
        <Button title="Retry" testID="subscription-retry" variant="secondary" onPress={onRetry} />
      </View>
    );
  }

  if (!subscription) {
    return (
      <View
        style={styles.card}
        testID="current-subscription-none"
        accessibilityLabel="No subscription. Free plan. Playback is locked."
      >
        <View style={styles.row}>
          <Ionicons name="lock-closed-outline" size={22} color={colors.textMuted} />
          <Text style={styles.title}>Free plan</Text>
        </View>
        <Text style={styles.muted}>
          You don\u2019t have a subscription. Premium playback is locked — subscribe below to
          unlock.
        </Text>
      </View>
    );
  }

  const color = statusColor(subscription.status);
  const icon = statusIcon(subscription.status);

  return (
    <View
      style={styles.card}
      testID="current-subscription"
      accessibilityLabel={`Current subscription: ${subscription.plan.name}, ${STATUS_LABEL[subscription.status]}, playback ${entitled ? 'unlocked' : 'locked'}`}
    >
      <View style={styles.row}>
        <Ionicons
          name={icon}
          size={22}
          color={color}
          accessibilityLabel={STATUS_LABEL[subscription.status]}
        />
        <Text style={styles.title}>{subscription.plan.name}</Text>
        <View
          style={[styles.badge, { borderColor: color }]}
          accessibilityLabel={`Status: ${STATUS_LABEL[subscription.status]}`}
        >
          <Text style={[styles.badgeText, { color }]}>{STATUS_LABEL[subscription.status]}</Text>
        </View>
      </View>

      <View style={styles.facts}>
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>Playback</Text>
          <Text
            style={styles.factValue}
            testID="subscription-entitlement"
            accessibilityLabel={entitled ? 'Playback unlocked' : 'Playback locked'}
          >
            {entitled ? 'Unlocked' : 'Locked'}
          </Text>
        </View>
        {subscription.status === 'TRIALING' ? (
          <View style={styles.factRow}>
            <Text style={styles.factLabel}>Trial ends</Text>
            <Text style={styles.factValue}>{formatDate(subscription.currentPeriodEnd)}</Text>
          </View>
        ) : null}
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>
            {subscription.status === 'CANCELED' || subscription.status === 'EXPIRED'
              ? 'Access ends'
              : subscription.status === 'ACTIVE' || subscription.status === 'TRIALING'
                ? 'Renews'
                : 'Period ends'}
          </Text>
          <Text style={styles.factValue}>{formatDate(subscription.currentPeriodEnd)}</Text>
        </View>
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>Current period</Text>
          <Text style={styles.factValue}>
            {formatDate(subscription.currentPeriodStart)} →{' '}
            {formatDate(subscription.currentPeriodEnd)}
          </Text>
        </View>
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>Billed via</Text>
          <Text style={styles.factValue}>{providerLabel(subscription.provider)}</Text>
        </View>
        {subscription.canceledAt ? (
          <View style={styles.factRow}>
            <Text style={styles.factLabel}>Canceled on</Text>
            <Text style={styles.factValue}>{formatDate(subscription.canceledAt)}</Text>
          </View>
        ) : null}
      </View>

      {/* Phase 18 semantics, surfaced explicitly in the UI. */}
      {subscription.status === 'CANCELED' ? (
        <Text style={styles.note} testID="canceled-note">
          Canceled subscriptions lose playback immediately, even within the paid period. Resubscribe
          below to restore access.
        </Text>
      ) : null}
      {subscription.status === 'PAST_DUE' ? (
        <Text style={styles.note} testID="past-due-note">
          Your payment didn\u2019t go through, so playback is locked. Update your payment method in
          the store, then refresh your status.
        </Text>
      ) : null}
      {subscription.status === 'EXPIRED' ? (
        <Text style={styles.note} testID="expired-note">
          Your subscription expired. Resubscribe below to restore Premium playback.
        </Text>
      ) : null}
      {subscription.status === 'REVOKED' ? (
        <Text style={styles.note} testID="revoked-note">
          Your subscription was revoked (for example, by a refund). Resubscribe below to restore
          Premium playback.
        </Text>
      ) : null}
    </View>
  );
}

// --- Plans -------------------------------------------------------------------

interface PlansSectionProps {
  products: StoreProduct[] | null;
  storeDetails: Record<string, { id: string; displayPrice?: string; title?: string }>;
  productsState: string;
  productsError: string | null;
  onLoad: () => void;
  onPurchase: (storeProductId: string) => void;
  hasSubscription: boolean;
  currentPlanCode: string | null;
}

function PlansSection({
  products,
  storeDetails,
  productsState,
  productsError,
  onLoad,
  onPurchase,
  hasSubscription,
  currentPlanCode,
}: PlansSectionProps) {
  // Load products on first render.
  const loaded = useRef(false);
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true;
      onLoad();
    }
  }, [onLoad]);

  if (productsState === 'loading-products' || productsState === 'idle') {
    return (
      <View style={styles.card} testID="plans-loading">
        <Text style={styles.muted}>Loading plans…</Text>
      </View>
    );
  }

  if (productsState === 'failed' && !products) {
    return (
      <View
        style={styles.card}
        testID="plans-error"
        accessibilityRole="alert"
        accessibilityLabel={`Could not load plans: ${productsError ?? 'unknown error'}`}
      >
        <Text style={styles.errorText}>Couldn\u2019t load plans.</Text>
        <Text style={styles.muted}>{productsError}</Text>
        <Button title="Retry" testID="plans-retry" variant="secondary" onPress={onLoad} />
      </View>
    );
  }

  if (!products || products.length === 0) {
    return (
      <View style={styles.card} testID="plans-empty">
        <Text style={styles.muted}>
          No subscription plans are currently available in the store. Please try again later.
        </Text>
        <Button title="Retry" testID="plans-retry" variant="secondary" onPress={onLoad} />
      </View>
    );
  }

  return (
    <View testID="plans-list" accessibilityLabel={`${products.length} plans available`}>
      <Text style={styles.sectionHeading} accessibilityRole="header">
        {hasSubscription ? 'Change plan' : 'Available plans'}
      </Text>
      {products.map((product) => {
        const sku = Platform.OS === 'ios' ? product.appleProductId : product.googleProductId;
        const detail = sku ? storeDetails[sku] : undefined;
        const isCurrent = product.planCode === currentPlanCode;
        // Price comes from the store (expo-iap) or is absent — never invented.
        const price = detail?.displayPrice ?? null;
        return (
          <View
            key={product.planCode}
            style={styles.card}
            testID={`plan-${product.planCode}`}
            accessibilityLabel={`${product.planName}${isCurrent ? ', current plan' : ''}${price ? `, ${price}` : ''}`}
          >
            <View style={styles.row}>
              <Text style={styles.title}>{product.planName}</Text>
              {isCurrent ? (
                <View style={[styles.badge, { borderColor: colors.primary }]}>
                  <Text style={[styles.badgeText, { color: colors.primary }]}>Current</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.muted}>
              {product.planType === 'INDIVIDUAL'
                ? '1 account'
                : product.planType === 'FAMILY'
                  ? 'Up to 6 accounts'
                  : 'Discounted for students'}
            </Text>
            <View style={styles.planFooter}>
              <Text
                style={styles.price}
                accessibilityLabel={price ? `Price: ${price}` : 'Price unavailable'}
              >
                {price ?? 'Price unavailable'}
              </Text>
              {!isCurrent && sku ? (
                <Button
                  title={hasSubscription ? 'Switch' : 'Subscribe'}
                  testID={`subscribe-${product.planCode}`}
                  accessibilityLabel={`${hasSubscription ? 'Switch to' : 'Subscribe to'} ${product.planName}${price ? ` for ${price}` : ''}`}
                  accessibilityHint="Opens the store purchase flow. The store handles payment."
                  size="md"
                  onPress={() => onPurchase(sku)}
                />
              ) : null}
            </View>
            {!sku ? (
              <Text style={styles.muted} testID={`plan-unavailable-${product.planCode}`}>
                Not available in {Platform.OS === 'ios' ? 'the App Store' : 'Google Play'}.
              </Text>
            ) : null}
          </View>
        );
      })}
      <Text style={styles.muted}>
        Prices are set by the {Platform.OS === 'ios' ? 'App Store' : 'Google Play'} and may vary by
        region. Plan changes are handled by the store.
      </Text>
    </View>
  );
}

// --- Styles ------------------------------------------------------------------

const styles = StyleSheet.create({
  scroll: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  heading: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  sectionHeading: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginTop: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    flex: 1,
  },
  badge: {
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  badgeText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  facts: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  factRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  factLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  factValue: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    textAlign: 'right',
    flexShrink: 1,
  },
  muted: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  errorText: {
    color: colors.error,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  note: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    fontStyle: 'italic',
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.md,
  },
  noticeText: {
    color: colors.text,
    fontSize: fontSize.sm,
    flex: 1,
  },
  actions: {
    gap: spacing.sm,
  },
  planFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  price: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  help: {
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  helpTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
});
