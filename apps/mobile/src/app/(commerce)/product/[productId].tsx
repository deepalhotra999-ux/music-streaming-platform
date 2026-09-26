// Phase 30 — product detail: variant selection, quantity, add to cart.
// Prices are server-authoritative; the client displays what the API returns.

import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../../auth';
import {
  addToCart,
  formatPrice,
  getProduct,
  type Product,
  type ProductVariant,
} from '../../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../../theme';
import { EmptyState, ErrorState, LoadingState, Price, StatusBadge } from '../../../commerce/ui';

export default function ProductDetailScreen() {
  const { productId } = useLocalSearchParams<{ productId: string }>();
  const { api: client } = useAuth();
  const { status } = useAuth();
  const [product, setProduct] = useState<Product | null>(null);
  const [variant, setVariant] = useState<ProductVariant | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!productId) return;
    setState('loading');
    try {
      const p = await getProduct(client, productId);
      setProduct(p);
      setVariant(p.variants[0] ?? null);
      setQuantity(1);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load product.');
      setState('error');
    }
  }, [client, productId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const purchasable = product?.status === 'ACTIVE';
  const selectedVariant = product?.variants.length ? variant : null;
  const maxQty = selectedVariant
    ? selectedVariant.availableQuantity
    : product
      ? Math.max(...product.variants.map((v) => v.availableQuantity), 0)
      : 0;

  const onAdd = async () => {
    if (!product || status !== 'authenticated') return;
    if (product.variants.length > 0 && !variant) {
      setNotice('Choose a variant first.');
      return;
    }
    setAdding(true);
    setNotice('');
    try {
      await addToCart(client, product.id, quantity, variant?.id);
      router.push('/(commerce)/cart');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not add to cart.');
    } finally {
      setAdding(false);
    }
  };

  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (!product) return <EmptyState label="Product not found." />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {product.images[0] ? (
        <Image
          source={{ uri: product.images[0].imageUrl }}
          style={styles.image}
          accessibilityRole="image"
          accessibilityLabel={`Product image: ${product.title}`}
        />
      ) : null}
      <View style={styles.row}>
        <Text style={styles.title}>{product.title}</Text>
        <StatusBadge status={product.status} />
      </View>
      <Price cents={product.priceCents} currency={product.currency} />
      {product.description ? <Text style={styles.desc}>{product.description}</Text> : null}

      {product.variants.length > 0 ? (
        <View style={styles.section} accessibilityRole="radiogroup" accessibilityLabel="Variant">
          <Text style={styles.sectionTitle}>Variant</Text>
          <View style={styles.chips}>
            {product.variants.map((v) => (
              <Pressable
                key={v.id}
                style={[styles.chip, variant?.id === v.id && styles.chipActive]}
                onPress={() => setVariant(v)}
                accessibilityRole="radio"
                accessibilityLabel={`${v.name}, ${formatPrice(v.priceCents, v.currency)}`}
                accessibilityState={{ selected: variant?.id === v.id }}
              >
                <Text style={[styles.chipLabel, variant?.id === v.id && styles.chipLabelActive]}>
                  {v.name}
                </Text>
              </Pressable>
            ))}
          </View>
          {variant ? <Text style={styles.muted}>{variant.availableQuantity} available</Text> : null}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quantity</Text>
        <View style={styles.qtyRow}>
          <Pressable
            style={styles.qtyButton}
            onPress={() => setQuantity((q) => Math.max(1, q - 1))}
            accessibilityRole="button"
            accessibilityLabel={`Decrease quantity, currently ${quantity}`}
            hitSlop={8}
          >
            <Text style={styles.qtyLabel}>−</Text>
          </Pressable>
          <Text style={styles.qtyValue} accessibilityLabel={`Quantity: ${quantity}`}>
            {quantity}
          </Text>
          <Pressable
            style={styles.qtyButton}
            onPress={() => setQuantity((q) => Math.min(Math.max(maxQty, 1), q + 1))}
            accessibilityRole="button"
            accessibilityLabel={`Increase quantity, currently ${quantity}`}
            hitSlop={8}
          >
            <Text style={styles.qtyLabel}>+</Text>
          </Pressable>
        </View>
      </View>

      {notice ? (
        <Text style={styles.notice} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          {notice}
        </Text>
      ) : null}

      <Pressable
        style={[styles.addButton, (!purchasable || adding) && styles.addButtonDisabled]}
        onPress={() => void onAdd()}
        disabled={!purchasable || adding}
        accessibilityRole="button"
        accessibilityLabel={
          adding
            ? 'Adding to cart'
            : purchasable
              ? `Add ${quantity} ${product.title} to cart`
              : `${product.title} not available`
        }
        accessibilityState={{ disabled: !purchasable || adding, busy: adding }}
      >
        <Text style={styles.addLabel}>
          {adding ? 'Adding…' : purchasable ? 'Add to cart' : `Not available (${product.status})`}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.md },
  image: { width: '100%', height: 240, borderRadius: 12, backgroundColor: colors.surface },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    flex: 1,
  },
  desc: { color: colors.textMuted, fontSize: fontSize.md },
  section: { gap: spacing.sm },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.textMuted,
  },
  chipActive: { borderColor: colors.primary, backgroundColor: colors.primaryFilled },
  chipLabel: { color: colors.text, fontSize: fontSize.sm },
  chipLabelActive: { color: colors.onPrimary, fontWeight: fontWeight.semibold },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  qtyButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyLabel: { color: colors.text, fontSize: fontSize.lg },
  qtyValue: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  notice: { color: colors.warning, fontSize: fontSize.sm },
  addButton: {
    backgroundColor: colors.primaryFilled,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  addButtonDisabled: { opacity: 0.5 },
  addLabel: {
    color: colors.onPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
});
