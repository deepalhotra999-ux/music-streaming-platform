// Phase 30 — cart, grouped by store. Quantities edit in place; the
// server re-prices every line.

import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../auth';
import {
  getCart,
  removeCartItem,
  updateCartItem,
  type Cart,
  type CartItem,
} from '../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { EmptyState, ErrorState, LoadingState, OfflineNotice, Price } from '../../commerce/ui';
import { useOnline } from '../../commerce/useOnline';

export default function CartScreen() {
  const { api: client } = useAuth();
  const online = useOnline();
  const [cart, setCart] = useState<Cart | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      setCart(await getCart(client));
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load cart.');
      setState('error');
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const setQty = async (item: CartItem, quantity: number) => {
    try {
      if (quantity <= 0) {
        setCart(await removeCartItem(client, item.id));
      } else {
        setCart(await updateCartItem(client, item.id, quantity));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update cart.');
      setState('error');
    }
  };

  if (!online) return <OfflineNotice />;
  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (!cart || cart.items.length === 0) {
    return <EmptyState label="Your cart is empty." />;
  }

  return (
    <View style={styles.root}>
      <FlatList
        data={
          cart.storeGroups.length > 0
            ? cart.storeGroups
            : [{ storeId: '', storeName: '', items: cart.items }]
        }
        keyExtractor={(g) => g.storeId || 'ungrouped'}
        contentContainerStyle={styles.list}
        renderItem={({ item: group }) => (
          <View>
            {group.storeName ? (
              <Text style={styles.groupTitle} accessibilityRole="header">
                {group.storeName}
              </Text>
            ) : null}
            {group.items.map((item) => (
              <View key={item.id} style={styles.card}>
                <View style={styles.row}>
                  <Text style={styles.title} numberOfLines={2}>
                    {item.product.title}
                  </Text>
                  <Pressable
                    onPress={() => void setQty(item, 0)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${item.product.title} from cart`}
                    hitSlop={8}
                  >
                    <Text style={styles.remove}>Remove</Text>
                  </Pressable>
                </View>
                {item.variant ? <Text style={styles.muted}>{item.variant.name}</Text> : null}
                <View style={styles.row}>
                  <View style={styles.qtyRow}>
                    <Pressable
                      style={styles.qtyButton}
                      onPress={() => void setQty(item, item.quantity - 1)}
                      accessibilityRole="button"
                      accessibilityLabel={`Decrease quantity of ${item.product.title}`}
                      hitSlop={8}
                    >
                      <Text style={styles.qtyLabel}>−</Text>
                    </Pressable>
                    <Text style={styles.qtyValue} accessibilityLabel={`Quantity: ${item.quantity}`}>
                      {item.quantity}
                    </Text>
                    <Pressable
                      style={styles.qtyButton}
                      onPress={() => void setQty(item, item.quantity + 1)}
                      accessibilityRole="button"
                      accessibilityLabel={`Increase quantity of ${item.product.title}`}
                      hitSlop={8}
                    >
                      <Text style={styles.qtyLabel}>+</Text>
                    </Pressable>
                  </View>
                  <Price
                    cents={(item.variant?.priceCents ?? item.product.priceCents) * item.quantity}
                    currency={item.product.currency}
                  />
                </View>
              </View>
            ))}
          </View>
        )}
      />
      <Pressable
        style={styles.checkout}
        onPress={() => router.push('/(commerce)/checkout')}
        accessibilityRole="button"
        accessibilityLabel="Proceed to checkout"
      >
        <Text style={styles.checkoutLabel}>Checkout</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  list: { padding: spacing.md, gap: spacing.sm },
  groupTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    flex: 1,
  },
  remove: { color: colors.error, fontSize: fontSize.sm },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  qtyButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyLabel: { color: colors.text, fontSize: fontSize.md },
  qtyValue: { color: colors.text, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  checkout: {
    margin: spacing.md,
    backgroundColor: colors.primaryFilled,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  checkoutLabel: {
    color: colors.onPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
});
