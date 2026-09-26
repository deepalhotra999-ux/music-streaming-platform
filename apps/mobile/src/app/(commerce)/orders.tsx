// Phase 30 — buyer order history.

import { Link, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth';
import { listOrders, formatPrice, type Order } from '../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Price,
  StatusBadge,
  OfflineNotice,
} from '../../commerce/ui';
import { useOnline } from '../../commerce/useOnline';

export default function OrdersScreen() {
  const { api: client } = useAuth();
  const online = useOnline();
  const [orders, setOrders] = useState<Order[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const page = await listOrders(client, { limit: 50 });
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

  if (!online) return <OfflineNotice />;
  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (orders.length === 0) return <EmptyState label="No orders yet." />;

  return (
    <FlatList
      style={styles.root}
      data={orders}
      keyExtractor={(o) => o.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <Link href={`/(commerce)/order/${item.id}`} asChild>
          <Pressable
            style={styles.card}
            accessibilityRole="button"
            accessibilityLabel={`Order ${item.orderNumber}, ${item.status.replace(/_/g, ' ').toLowerCase()}, ${item.items.length} item${item.items.length === 1 ? '' : 's'}, ${formatPrice(item.totalCents, item.currency)}`}
          >
            <View style={styles.row}>
              <Text style={styles.number}>#{item.orderNumber}</Text>
              <StatusBadge status={item.status} />
            </View>
            <View style={styles.row}>
              <Text style={styles.muted}>
                {item.items.length} item{item.items.length === 1 ? '' : 's'} ·{' '}
                {new Date(item.createdAt).toLocaleDateString()}
              </Text>
              <Price cents={item.totalCents} currency={item.currency} />
            </View>
          </Pressable>
        </Link>
      )}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  list: { padding: spacing.md, gap: spacing.sm },
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
    gap: spacing.sm,
  },
  number: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
});
