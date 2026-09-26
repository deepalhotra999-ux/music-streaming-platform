// Phase 30 — order detail: line items, payment status, retry/cancel for
// unpaid orders. Shipping address is the buyer's own — visible here only.

import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../../auth';
import {
  cancelOrder,
  getOrder,
  retryPayment,
  confirmPayment,
  type Order,
} from '../../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../../theme';
import { EmptyState, ErrorState, LoadingState, Price, StatusBadge } from '../../../commerce/ui';

export default function OrderDetailScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>();
  const { api: client } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) return;
    setState('loading');
    try {
      setOrder(await getOrder(client, orderId));
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load order.');
      setState('error');
    }
  }, [client, orderId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const act = async (fn: () => Promise<Order>) => {
    setBusy(true);
    setError('');
    try {
      setOrder(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (!order) return <EmptyState label="Order not found." />;

  const unpaid = order.status === 'PENDING_PAYMENT';

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.row}>
        <Text style={styles.number}>#{order.orderNumber}</Text>
        <StatusBadge status={order.status} />
      </View>
      <Text style={styles.muted}>
        Placed {new Date(order.createdAt).toLocaleString()}
      </Text>

      {order.items.map((item) => (
        <View key={item.id} style={styles.line}>
          <Text style={styles.lineTitle} numberOfLines={2}>
            {item.productTitle}
            {item.variantName ? ` — ${item.variantName}` : ''} × {item.quantity}
          </Text>
          <Price cents={item.unitPriceCents * item.quantity} currency={item.currency} />
        </View>
      ))}

      <View style={styles.totals}>
        <View style={styles.line}>
          <Text style={styles.muted}>Subtotal</Text>
          <Price cents={order.subtotalCents} currency={order.currency} />
        </View>
        <View style={styles.line}>
          <Text style={styles.muted}>Shipping</Text>
          <Price cents={order.shippingCents} currency={order.currency} />
        </View>
        <View style={styles.line}>
          <Text style={styles.totalLabel}>Total</Text>
          <Price cents={order.totalCents} currency={order.currency} />
        </View>
      </View>

      <View style={styles.row}>
        <Text style={styles.muted}>Fulfillment</Text>
        <StatusBadge status={order.fulfillmentStatus} />
      </View>
      {order.trackingNumber ? (
        <Text style={styles.muted}>Tracking: {order.trackingNumber}</Text>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {unpaid ? (
        <View style={styles.actions}>
          <Pressable
            style={[styles.primary, busy && styles.disabled]}
            onPress={() => void act(() => retryPayment(client, order.id).then(() => confirmPayment(client, order.id)))}
            disabled={busy}
          >
            <Text style={styles.primaryLabel}>{busy ? 'Working…' : 'Retry payment'}</Text>
          </Pressable>
          <Pressable
            style={[styles.secondary, busy && styles.disabled]}
            onPress={() => void act(() => cancelOrder(client, order.id))}
            disabled={busy}
          >
            <Text style={styles.secondaryLabel}>Cancel order</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  number: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
  },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  lineTitle: { color: colors.text, fontSize: fontSize.sm, flex: 1 },
  totals: {
    borderTopWidth: 1,
    borderTopColor: colors.surface,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  totalLabel: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  error: { color: colors.error, fontSize: fontSize.sm },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  primaryLabel: {
    color: colors.background,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  secondary: {
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  secondaryLabel: { color: colors.text, fontSize: fontSize.md },
  disabled: { opacity: 0.5 },
});
