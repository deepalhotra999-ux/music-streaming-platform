// Phase 30 — artist order management: list store orders, update fulfillment
// status, and issue refunds. Store owners see only their own store's orders.

import { useFocusEffect } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TextInput } from '../../components';
import { useAuth } from '../../auth';
import { listMyArtists } from '../../api/artist';
import {
  formatPrice,
  getMyStore,
  getOrder,
  listStoreOrders,
  refundOrder,
  updateFulfillment,
  type Order,
  type Store,
} from '../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { EmptyState, ErrorState, LoadingState, StatusBadge } from '../../commerce/ui';
import { useOnline } from '../../commerce/useOnline';

const FULFILLMENT_STEPS = ['UNFULFILLED', 'PROCESSING', 'SHIPPED', 'DELIVERED'] as const;

export default function ArtistOrdersScreen() {
  const { api: client } = useAuth();
  const online = useOnline();
  const [store, setStore] = useState<Store | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<Order | null>(null);
  const [refundReason, setRefundReason] = useState('');
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    setActionError('');
    try {
      const mine = await listMyArtists(client);
      const artistId = mine.data[0]?.id ?? null;
      if (!artistId) throw new Error('No artist profile found.');
      const s = await getMyStore(client, artistId);
      setStore(s);
      const page = await listStoreOrders(client, s.id, { limit: 100 });
      setOrders(page.data);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load orders.');
      setState('error');
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const advanceFulfillment = async (order: Order) => {
    const idx = FULFILLMENT_STEPS.indexOf(
      order.fulfillmentStatus as (typeof FULFILLMENT_STEPS)[number],
    );
    const next = FULFILLMENT_STEPS[idx + 1];
    if (!next) return;
    setActing(true);
    setActionError('');
    try {
      const updated = await updateFulfillment(client, order.id, { fulfillmentStatus: next });
      setOrders((os) => os.map((o) => (o.id === order.id ? updated : o)));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not update fulfillment.');
    } finally {
      setActing(false);
    }
  };

  const doRefund = async () => {
    if (!refundFor) return;
    setActing(true);
    setActionError('');
    try {
      await refundOrder(client, refundFor.id, randomUUID(), refundReason.trim() || undefined);
      // Refresh the order to show the refunded status.
      const updated = await getOrder(client, refundFor.id);
      setOrders((os) => os.map((o) => (o.id === refundFor.id ? updated : o)));
      setRefundFor(null);
      setRefundReason('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Refund failed.');
    } finally {
      setActing(false);
    }
  };

  if (!online) return <OfflineNotice />;
  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (!store) return <EmptyState label="Create a store first." />;
  if (orders.length === 0) return <EmptyState label="No orders yet." />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {actionError ? (
        <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          {actionError}
        </Text>
      ) : null}
      {orders.map((order) => {
        const expanded = expandedId === order.id;
        const idx = FULFILLMENT_STEPS.indexOf(
          order.fulfillmentStatus as (typeof FULFILLMENT_STEPS)[number],
        );
        const nextStep = FULFILLMENT_STEPS[idx + 1];
        return (
          <View key={order.id} style={styles.card}>
            <Pressable
              onPress={() => setExpandedId(expanded ? null : order.id)}
              accessibilityRole="button"
              accessibilityLabel={`Order ${order.orderNumber}, ${expanded ? 'expanded' : 'collapsed'}`}
              accessibilityState={{ expanded }}
              accessibilityHint={
                expanded ? 'Collapses order details' : 'Shows order details and actions'
              }
            >
              <View style={styles.row}>
                <Text style={styles.title}>#{order.orderNumber}</Text>
                <StatusBadge status={order.status} />
              </View>
              <View style={styles.row}>
                <Text style={styles.muted}>{new Date(order.createdAt).toLocaleDateString()}</Text>
                <Text style={styles.total}>{formatPrice(order.totalCents, order.currency)}</Text>
              </View>
            </Pressable>
            {expanded ? (
              <View style={styles.detail}>
                <Text style={styles.muted}>
                  Fulfillment: {order.fulfillmentStatus.replace(/_/g, ' ').toLowerCase()}
                </Text>
                {order.items.map((item) => (
                  <Text key={item.id} style={styles.muted}>
                    {item.productTitle}
                    {item.variantName ? ` — ${item.variantName}` : ''} × {item.quantity}
                  </Text>
                ))}
                <View style={styles.actions}>
                  {nextStep && order.status === 'PAID' ? (
                    <Pressable
                      style={styles.button}
                      disabled={acting}
                      onPress={() => void advanceFulfillment(order)}
                      accessibilityRole="button"
                      accessibilityLabel={`Mark order ${order.orderNumber} as ${nextStep.toLowerCase()}`}
                      accessibilityState={{ disabled: acting, busy: acting }}
                    >
                      <Text style={styles.buttonLabel}>Mark {nextStep.toLowerCase()}</Text>
                    </Pressable>
                  ) : null}
                  {(order.status === 'PAID' || order.status === 'PROCESSING') && !refundFor ? (
                    <Pressable
                      style={[styles.button, styles.danger]}
                      onPress={() => setRefundFor(order)}
                      accessibilityRole="button"
                      accessibilityLabel={`Refund order ${order.orderNumber}, full refund of ${formatPrice(order.totalCents, order.currency)}`}
                    >
                      <Text style={styles.dangerLabel}>Refund</Text>
                    </Pressable>
                  ) : null}
                </View>
                {refundFor?.id === order.id ? (
                  <View style={styles.refundForm}>
                    <Text style={styles.muted}>
                      Full refund of {formatPrice(order.totalCents, order.currency)}
                    </Text>
                    <TextInput
                      label={`Refund reason for order ${order.orderNumber}`}
                      placeholder="Optional"
                      value={refundReason}
                      onChangeText={setRefundReason}
                    />
                    <View style={styles.actions}>
                      <Pressable
                        style={styles.button}
                        disabled={acting}
                        onPress={() => void doRefund()}
                        accessibilityRole="button"
                        accessibilityLabel={
                          acting
                            ? 'Issuing refund'
                            : `Issue full refund for order ${order.orderNumber}`
                        }
                        accessibilityState={{ disabled: acting, busy: acting }}
                      >
                        <Text style={styles.buttonLabel}>Issue refund</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.button, styles.secondary]}
                        onPress={() => setRefundFor(null)}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel refund"
                      >
                        <Text style={styles.buttonLabel}>Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function OfflineNotice() {
  return (
    <View style={styles.center}>
      <Text style={styles.muted}>You&apos;re offline. Order management needs a connection.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { color: colors.text, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  total: { color: colors.text, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  detail: { marginTop: spacing.sm, gap: spacing.xs },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  button: {
    backgroundColor: colors.primaryFilled,
    borderRadius: 8,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  secondary: { backgroundColor: colors.background },
  danger: { backgroundColor: colors.error },
  buttonLabel: { color: colors.onPrimary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  // Phase 31 — white on the error background is 2.78:1; dark text is 7.08:1.
  dangerLabel: { color: colors.background, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  refundForm: { gap: spacing.sm, marginTop: spacing.sm },
  error: { color: colors.error, fontSize: fontSize.sm, marginBottom: spacing.sm },
});
