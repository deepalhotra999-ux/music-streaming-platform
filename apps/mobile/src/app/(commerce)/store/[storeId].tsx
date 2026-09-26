// Phase 30 — public storefront: store details plus its product grid.

import { Link, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../../auth';
import {
  formatPrice,
  getStore,
  listStoreProducts,
  type Product,
  type Store,
} from '../../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../../theme';
import { EmptyState, ErrorState, LoadingState, Price, StatusBadge } from '../../../commerce/ui';

export default function StoreDetailScreen() {
  const { storeId } = useLocalSearchParams<{ storeId: string }>();
  const { api: client } = useAuth();
  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!storeId) return;
    setState('loading');
    try {
      const [s, p] = await Promise.all([
        getStore(client, storeId),
        listStoreProducts(client, storeId, { limit: 50 }),
      ]);
      setStore(s);
      setProducts(p.data);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load store.');
      setState('error');
    }
  }, [client, storeId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (!store) return <EmptyState label="Store not found." />;

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.row}>
          <Text style={styles.name}>{store.name}</Text>
          <StatusBadge status={store.status} />
        </View>
        {store.description ? <Text style={styles.desc}>{store.description}</Text> : null}
      </View>
      {products.length === 0 ? (
        <EmptyState label="No products in this store yet." />
      ) : (
        <FlatList
          data={products}
          keyExtractor={(p) => p.id}
          numColumns={2}
          contentContainerStyle={styles.list}
          columnWrapperStyle={styles.columns}
          renderItem={({ item }) => (
            <Link href={`/(commerce)/product/${item.id}`} asChild>
              <Pressable
                style={styles.card}
                accessibilityRole="button"
                accessibilityLabel={`View product: ${item.title}, ${formatPrice(item.priceCents, item.currency)}`}
              >
                <Text style={styles.title} numberOfLines={2}>
                  {item.title}
                </Text>
                <Price cents={item.priceCents} currency={item.currency} />
                <StatusBadge status={item.status} />
              </Pressable>
            </Link>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { padding: spacing.md, gap: spacing.xs },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  name: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    flex: 1,
  },
  desc: { color: colors.textMuted, fontSize: fontSize.md },
  list: { padding: spacing.md, gap: spacing.sm },
  columns: { gap: spacing.sm },
  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.xs,
  },
  title: { color: colors.text, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
});
