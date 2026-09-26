// Phase 30 — artist product management: list, create, edit, archive,
// inventory, and fulfillment shortcuts.

import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAuth } from '../../auth';
import { listMyArtists } from '../../api/artist';
import {
  archiveProduct,
  createProduct,
  formatPrice,
  getMyStore,
  listStoreProducts,
  setInventory,
  type Product,
  type Store,
} from '../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { EmptyState, ErrorState, LoadingState, Price, StatusBadge } from '../../commerce/ui';

export default function ArtistProductsScreen() {
  const { api: client } = useAuth();
  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [stockFor, setStockFor] = useState<Product | null>(null);
  const [stockQty, setStockQty] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const mine = await listMyArtists(client);
      const id = mine.data[0]?.id ?? null;
      if (!id) {
        setState('error');
        setError('No artist profile found.');
        return;
      }
      const s = await getMyStore(client, id);
      setStore(s);
      const p = await listStoreProducts(client, s.id, { limit: 100 });
      setProducts(p.data);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load products.');
      setState('error');
    }
  }, [client]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const create = async () => {
    if (!store || !title.trim()) return;
    const cents = Math.round(parseFloat(price) * 100);
    if (!Number.isSafeInteger(cents) || cents < 1) {
      setError('Enter a valid price.');
      return;
    }
    setSaving(true);
    try {
      await createProduct(client, {
        storeId: store.id,
        title: title.trim(),
        priceCents: cents,
        status: 'DRAFT',
      });
      setShowCreate(false);
      setTitle('');
      setPrice('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create product.');
    } finally {
      setSaving(false);
    }
  };

  const archive = async (p: Product) => {
    try {
      await archiveProduct(client, p.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not archive product.');
    }
  };

  const saveStock = async () => {
    if (!stockFor) return;
    const qty = parseInt(stockQty, 10);
    if (!Number.isSafeInteger(qty) || qty < 0) {
      setError('Enter a valid quantity.');
      return;
    }
    try {
      // Variant products need per-variant stock; this shortcut handles
      // simple products. Variant stock is managed on the product screen.
      await setInventory(client, stockFor.id, qty);
      setStockFor(null);
      setStockQty('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set stock.');
    }
  };

  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (!store) {
    return (
      <EmptyState label="Create your store first." />
    );
  }

  return (
    <View style={styles.root}>
      <FlatList
        data={products}
        keyExtractor={(p) => p.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<EmptyState label="No products yet." />}
        renderItem={({ item }) => (
          <Pressable
            style={styles.card}
            onPress={() => router.push(`/(artist)/product/${item.id}`)}
          >
            <View style={styles.row}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              <StatusBadge status={item.status} />
            </View>
            <View style={styles.row}>
              <Price cents={item.priceCents} currency={item.currency} />
              <Text style={styles.muted}>
                {item.variants.length} variant{item.variants.length === 1 ? '' : 's'}
              </Text>
            </View>
            <View style={styles.actions}>
              <Pressable
                style={styles.action}
                onPress={() => {
                  setStockFor(item);
                  setStockQty('');
                }}
              >
                <Text style={styles.actionLabel}>Stock</Text>
              </Pressable>
              {item.status !== 'ARCHIVED' && item.status !== 'REMOVED' ? (
                <Pressable style={styles.action} onPress={() => void archive(item)}>
                  <Text style={styles.actionLabel}>Archive</Text>
                </Pressable>
              ) : null}
            </View>
          </Pressable>
        )}
      />
      <Pressable style={styles.fab} onPress={() => setShowCreate(true)}>
        <Text style={styles.fabLabel}>+ New product</Text>
      </Pressable>

      <Modal visible={showCreate} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>New product</Text>
            <TextInput
              style={styles.input}
              placeholder="Title"
              placeholderTextColor={colors.textMuted}
              value={title}
              onChangeText={setTitle}
            />
            <TextInput
              style={styles.input}
              placeholder="Price (e.g. 25.00)"
              placeholderTextColor={colors.textMuted}
              value={price}
              onChangeText={setPrice}
              keyboardType="decimal-pad"
            />
            <Text style={styles.muted}>
              {price
                ? formatPrice(Math.round(parseFloat(price || '0') * 100) || 0, store.currency)
                : ''}
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable
                style={styles.secondary}
                onPress={() => {
                  setShowCreate(false);
                  setError('');
                }}
              >
                <Text style={styles.secondaryLabel}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.primary, saving && styles.disabled]}
                onPress={() => void create()}
                disabled={saving}
              >
                <Text style={styles.primaryLabel}>{saving ? 'Creating…' : 'Create'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!stockFor} animationType="slide" transparent>
        <View style={styles.modalWrap}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Set stock — {stockFor?.title}</Text>
            <TextInput
              style={styles.input}
              placeholder="Quantity available"
              placeholderTextColor={colors.textMuted}
              value={stockQty}
              onChangeText={setStockQty}
              keyboardType="number-pad"
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable
                style={styles.secondary}
                onPress={() => {
                  setStockFor(null);
                  setError('');
                }}
              >
                <Text style={styles.secondaryLabel}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.primary} onPress={() => void saveStock()}>
                <Text style={styles.primaryLabel}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
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
  title: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    flex: 1,
  },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  action: {
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    backgroundColor: colors.background,
  },
  actionLabel: { color: colors.primary, fontSize: fontSize.sm },
  fab: {
    margin: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  fabLabel: {
    color: colors.background,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  modalWrap: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  modalTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: spacing.sm,
    color: colors.text,
    fontSize: fontSize.md,
  },
  modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  primary: {
    flex: 1,
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
    flex: 1,
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  secondaryLabel: { color: colors.text, fontSize: fontSize.md },
  error: { color: colors.error, fontSize: fontSize.sm },
  disabled: { opacity: 0.5 },
});
