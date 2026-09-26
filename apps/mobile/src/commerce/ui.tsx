// Phase 30 — shared commerce UI primitives: loading/empty/error states,
// price display, and status badges. Keeps the commerce screens consistent.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fontSize, fontWeight, spacing } from '../theme';
import { formatPrice } from '../api/commerce';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <View style={styles.center}>
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

/** Commerce is online-only: show this instead of commerce content when offline. */
export function OfflineNotice() {
  return (
    <View style={styles.center}>
      <Text style={styles.muted}>
        You&apos;re offline. Browsing stores, carts, and checkout need a connection.
      </Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.center}>
      <Text style={styles.error}>{message}</Text>
      <Pressable style={styles.retryButton} onPress={onRetry}>
        <Text style={styles.retryLabel}>Retry</Text>
      </Pressable>
    </View>
  );
}

export function Price({ cents, currency }: { cents: number; currency: string }) {
  return <Text style={styles.price}>{formatPrice(cents, currency)}</Text>;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: colors.success,
  PAID: colors.success,
  DELIVERED: colors.success,
  DRAFT: colors.textMuted,
  PAUSED: colors.warning,
  PENDING_PAYMENT: colors.warning,
  PROCESSING: colors.warning,
  FULFILLING: colors.warning,
  SHIPPED: colors.primary,
  SOLD_OUT: colors.warning,
  CANCELED: colors.textMuted,
  REFUNDED: colors.textMuted,
  ARCHIVED: colors.textMuted,
  REMOVED: colors.error,
  SUSPENDED: colors.error,
  UNFULFILLED: colors.textMuted,
};

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? colors.textMuted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeLabel, { color }]}>{status.replace(/_/g, ' ')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
  },
  muted: {
    color: colors.textMuted,
    fontSize: fontSize.md,
    textAlign: 'center',
  },
  error: {
    color: colors.error,
    fontSize: fontSize.md,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  retryLabel: {
    color: colors.background,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  price: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  badge: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 2,
    paddingHorizontal: 8,
    alignSelf: 'flex-start',
  },
  badgeLabel: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
});
