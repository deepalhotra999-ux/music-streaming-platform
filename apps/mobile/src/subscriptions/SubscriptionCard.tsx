// Phase 18 — subscription status card.
// Displays the server-reported subscription: plan name, status badge,
// current period end, and the authoritative entitlement state. Loading,
// error (with retry), and no-subscription states are all explicit.

import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { MySubscription, SubscriptionStatus } from '../api';
import { Button } from '../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';

interface SubscriptionCardProps {
  data: MySubscription | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: 'Active',
  TRIALING: 'Trial',
  PAST_DUE: 'Past due',
  CANCELED: 'Canceled',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

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

export function SubscriptionCard({ data, loading, error, onRetry }: SubscriptionCardProps) {
  if (loading) {
    return (
      <View style={styles.card} testID="subscription-card-loading">
        <Text style={styles.muted}>Checking subscription…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.card} testID="subscription-card-error">
        <Text style={styles.errorText}>Couldn&apos;t load subscription.</Text>
        <Text style={styles.muted}>{error}</Text>
        <Button title="Retry" testID="subscription-retry" onPress={onRetry} variant="secondary" />
      </View>
    );
  }

  const { subscription, entitlement } = data ?? { subscription: null, entitlement: null };

  if (!subscription) {
    return (
      <View style={styles.card} testID="subscription-card-none">
        <View style={styles.row}>
          <Ionicons name="lock-closed-outline" size={22} color={colors.textMuted} />
          <Text style={styles.title}>Free plan</Text>
        </View>
        <Text style={styles.muted}>
          Playback requires a Premium subscription. Subscribe in the App Store or Google Play.
        </Text>
      </View>
    );
  }

  const badge = statusColor(subscription.status);

  return (
    <View style={styles.card} testID="subscription-card">
      <View style={styles.row}>
        <Ionicons
          name={entitlement?.entitled ? 'checkmark-circle' : 'lock-closed'}
          size={22}
          color={entitlement?.entitled ? colors.success : colors.warning}
        />
        <Text style={styles.title}>{subscription.plan.name}</Text>
        <View style={[styles.badge, { borderColor: badge }]}>
          <Text style={[styles.badgeText, { color: badge }]}>
            {STATUS_LABEL[subscription.status]}
          </Text>
        </View>
      </View>

      <View style={styles.facts}>
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>Playback</Text>
          <Text style={styles.factValue} testID="subscription-entitlement">
            {entitlement?.entitled ? 'Unlocked' : 'Locked'}
          </Text>
        </View>
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>Renews / ends</Text>
          <Text style={styles.factValue}>{formatDate(subscription.currentPeriodEnd)}</Text>
        </View>
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>Billed via</Text>
          <Text style={styles.factValue}>
            {subscription.provider === 'APPLE'
              ? 'App Store'
              : subscription.provider === 'GOOGLE'
                ? 'Google Play'
                : 'Development'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
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
  },
  factLabel: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  factValue: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
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
});
