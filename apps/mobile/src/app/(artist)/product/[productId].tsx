// Phase 30 — artist product detail: edit product, manage variants,
// images, and inventory. All changes are audited server-side.

import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useAuth } from '../../../auth';
import {
  addProductImage,
  createVariant,
  deleteVariant,
  formatPrice,
  getInventory,
  getProduct,
  removeProductImage,
  reorderProductImages,
  setInventory,
  updateProduct,
  type InventoryRow,
  type Product,
  type ProductVariant,
} from '../../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../../theme';
import { EmptyState, ErrorState, LoadingState, StatusBadge } from '../../../commerce/ui';
import { useOnline } from '../../../commerce/useOnline';

export default function ArtistProductDetailScreen() {
  const { productId } = useLocalSearchParams<{ productId: string }>();
  const { api: client } = useAuth();
  const online = useOnline();
  const [product, setProduct] = useState<Product | null>(null);
  const [inventory, setInventoryRows] = useState<InventoryRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [acting, setActing] = useState(false);

  // Edit fields
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');

  // Variant form
  const [showVariantForm, setShowVariantForm] = useState(false);
  const [variantName, setVariantName] = useState('');
  const [variantPrice, setVariantPrice] = useState('');
  const [variantSku, setVariantSku] = useState('');

  // Image form
  const [imageUrl, setImageUrl] = useState('');
  const [imageAlt, setImageAlt] = useState('');

  // Inventory form
  const [stockFor, setStockFor] = useState<{ variantId: string | null; label: string } | null>(null);
  const [stockQty, setStockQty] = useState('');

  const load = useCallback(async () => {
    if (!productId) return;
    setState('loading');
    try {
      const p = await getProduct(client, productId);
      setProduct(p);
      setTitle(p.title);
      setDescription(p.description ?? '');
      setPrice((p.priceCents / 100).toFixed(2));
      const inv = await getInventory(client, productId);
      setInventoryRows(inv);
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

  const refresh = async () => {
    if (!productId) return;
    const p = await getProduct(client, productId);
    setProduct(p);
    setInventoryRows(await getInventory(client, productId));
  };

  const saveProduct = async () => {
    if (!product) return;
    const cents = Math.round(parseFloat(price) * 100);
    if (!title.trim() || !Number.isFinite(cents) || cents < 0) {
      setActionError('Enter a valid title and price.');
      return;
    }
    setActing(true);
    setActionError('');
    try {
      const updated = await updateProduct(client, product.id, {
        title: title.trim(),
        description: description.trim() || null,
        priceCents: cents,
      });
      setProduct(updated);
      setEditing(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not save product.');
    } finally {
      setActing(false);
    }
  };

  const saveVariant = async () => {
    if (!product) return;
    const cents = Math.round(parseFloat(variantPrice) * 100);
    if (!variantName.trim() || !Number.isFinite(cents) || cents < 0) {
      setActionError('Enter a valid variant name and price.');
      return;
    }
    setActing(true);
    setActionError('');
    try {
      await createVariant(client, product.id, {
        name: variantName.trim(),
        priceCents: cents,
        sku: variantSku.trim() || undefined,
      });
      setVariantName('');
      setVariantPrice('');
      setVariantSku('');
      setShowVariantForm(false);
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not create variant.');
    } finally {
      setActing(false);
    }
  };

  const removeVariant = async (variant: ProductVariant) => {
    setActing(true);
    setActionError('');
    try {
      await deleteVariant(client, product!.id, variant.id);
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not delete variant.');
    } finally {
      setActing(false);
    }
  };

  const addImage = async () => {
    if (!product || !imageUrl.trim()) {
      setActionError('Enter an image URL.');
      return;
    }
    setActing(true);
    setActionError('');
    try {
      await addProductImage(client, product.id, imageUrl.trim(), imageAlt.trim() || undefined);
      setImageUrl('');
      setImageAlt('');
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not add image.');
    } finally {
      setActing(false);
    }
  };

  const moveImage = async (index: number, dir: -1 | 1) => {
    if (!product) return;
    const images = [...product.images];
    const j = index + dir;
    if (j < 0 || j >= images.length) return;
    [images[index], images[j]] = [images[j], images[index]];
    setActing(true);
    try {
      await reorderProductImages(client, product.id, images.map((i) => i.id));
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not reorder images.');
    } finally {
      setActing(false);
    }
  };

  const saveStock = async () => {
    if (!product || !stockFor) return;
    const qty = parseInt(stockQty, 10);
    if (!Number.isFinite(qty) || qty < 0) {
      setActionError('Enter a valid quantity.');
      return;
    }
    setActing(true);
    setActionError('');
    try {
      const rows = await setInventory(client, product.id, qty, stockFor.variantId ?? undefined);
      setInventoryRows(rows);
      setStockFor(null);
      setStockQty('');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not set inventory.');
    } finally {
      setActing(false);
    }
  };

  const stockForKey = (variantId: string | null) => variantId ?? 'base';
  const stockMap = new Map(inventory.map((r) => [stockForKey(r.variantId), r]));

  if (!online) return <OfflineNotice />;
  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (!product) return <EmptyState label="Product not found." />;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {actionError ? <Text style={styles.error}>{actionError}</Text> : null}

      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.sectionTitle}>Details</Text>
          <StatusBadge status={product.status} />
        </View>
        {editing ? (
          <>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              placeholder="Title"
              placeholderTextColor={colors.textMuted}
            />
            <TextInput
              style={[styles.input, styles.multiline]}
              value={description}
              onChangeText={setDescription}
              placeholder="Description"
              placeholderTextColor={colors.textMuted}
              multiline
            />
            <TextInput
              style={styles.input}
              value={price}
              onChangeText={setPrice}
              placeholder="Price"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
            />
            <View style={styles.actions}>
              <Pressable style={styles.button} disabled={acting} onPress={() => void saveProduct()}>
                <Text style={styles.buttonLabel}>Save</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.secondary]} onPress={() => setEditing(false)}>
                <Text style={styles.buttonLabel}>Cancel</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title}>{product.title}</Text>
            {product.description ? (
              <Text style={styles.muted}>{product.description}</Text>
            ) : null}
            <Text style={styles.price}>{formatPrice(product.priceCents, product.currency)}</Text>
            <Pressable style={styles.linkButton} onPress={() => setEditing(true)}>
              <Text style={styles.link}>Edit details</Text>
            </Pressable>
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Variants</Text>
        {product.variants.length === 0 ? (
          <Text style={styles.muted}>No variants. Simple product.</Text>
        ) : null}
        {product.variants.map((v) => (
          <View key={v.id} style={styles.row}>
            <View>
              <Text style={styles.title}>{v.name}</Text>
              <Text style={styles.muted}>{formatPrice(v.priceCents, product.currency)}</Text>
            </View>
            <Pressable disabled={acting} onPress={() => void removeVariant(v)}>
              <Text style={styles.danger}>Delete</Text>
            </Pressable>
          </View>
        ))}
        {showVariantForm ? (
          <View style={styles.form}>
            <TextInput
              style={styles.input}
              value={variantName}
              onChangeText={setVariantName}
              placeholder="Variant name (e.g. Large)"
              placeholderTextColor={colors.textMuted}
            />
            <TextInput
              style={styles.input}
              value={variantPrice}
              onChangeText={setVariantPrice}
              placeholder="Price"
              placeholderTextColor={colors.textMuted}
              keyboardType="decimal-pad"
            />
            <TextInput
              style={styles.input}
              value={variantSku}
              onChangeText={setVariantSku}
              placeholder="SKU (optional)"
              placeholderTextColor={colors.textMuted}
            />
            <View style={styles.actions}>
              <Pressable style={styles.button} disabled={acting} onPress={() => void saveVariant()}>
                <Text style={styles.buttonLabel}>Add variant</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.secondary]}
                onPress={() => setShowVariantForm(false)}
              >
                <Text style={styles.buttonLabel}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable style={styles.linkButton} onPress={() => setShowVariantForm(true)}>
            <Text style={styles.link}>+ Add variant</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Images</Text>
        {product.images.map((img, i) => (
          <View key={img.id} style={styles.row}>
            <Text style={styles.muted} numberOfLines={1}>
              {i + 1}. {img.imageUrl}
            </Text>
            <View style={styles.actions}>
              {i > 0 ? (
                <Pressable disabled={acting} onPress={() => void moveImage(i, -1)}>
                  <Text style={styles.link}>↑</Text>
                </Pressable>
              ) : null}
              {i < product.images.length - 1 ? (
                <Pressable disabled={acting} onPress={() => void moveImage(i, 1)}>
                  <Text style={styles.link}>↓</Text>
                </Pressable>
              ) : null}
              <Pressable
                disabled={acting}
                onPress={() =>
                  void removeProductImage(client, img.id)
                    .then(() => refresh())
                    .catch((e: unknown) =>
                      setActionError(e instanceof Error ? e.message : 'Could not remove image.'),
                    )
                }
              >
                <Text style={styles.danger}>Remove</Text>
              </Pressable>
            </View>
          </View>
        ))}
        <View style={styles.form}>
          <TextInput
            style={styles.input}
            value={imageUrl}
            onChangeText={setImageUrl}
            placeholder="Image URL"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
          />
          <TextInput
            style={styles.input}
            value={imageAlt}
            onChangeText={setImageAlt}
            placeholder="Alt text (optional)"
            placeholderTextColor={colors.textMuted}
          />
          <Pressable style={styles.button} disabled={acting} onPress={() => void addImage()}>
            <Text style={styles.buttonLabel}>Add image</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Inventory</Text>
        <InventoryRowView
          label="Base product"
          row={stockMap.get('base')}
          onSet={() => {
            setStockFor({ variantId: null, label: 'Base product' });
            setStockQty(String(stockMap.get('base')?.quantityAvailable ?? 0));
          }}
        />
        {product.variants.map((v) => (
          <InventoryRowView
            key={v.id}
            label={v.name}
            row={stockMap.get(v.id)}
            onSet={() => {
              setStockFor({ variantId: v.id, label: v.name });
              setStockQty(String(stockMap.get(v.id)?.quantityAvailable ?? 0));
            }}
          />
        ))}
        {stockFor ? (
          <View style={styles.form}>
            <Text style={styles.muted}>Set stock for {stockFor.label}</Text>
            <TextInput
              style={styles.input}
              value={stockQty}
              onChangeText={setStockQty}
              placeholder="Quantity"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
            />
            <View style={styles.actions}>
              <Pressable style={styles.button} disabled={acting} onPress={() => void saveStock()}>
                <Text style={styles.buttonLabel}>Set stock</Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.secondary]}
                onPress={() => setStockFor(null)}
              >
                <Text style={styles.buttonLabel}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

function InventoryRowView({
  label,
  row,
  onSet,
}: {
  label: string;
  row: InventoryRow | undefined;
  onSet: () => void;
}) {
  return (
    <View style={styles.row}>
      <View>
        <Text style={styles.title}>{label}</Text>
        <Text style={styles.muted}>
          {row ? `${row.quantityAvailable} available, ${row.quantityReserved} reserved` : 'No stock set'}
        </Text>
      </View>
      <Pressable onPress={onSet}>
        <Text style={styles.link}>Set stock</Text>
      </Pressable>
    </View>
  );
}

function OfflineNotice() {
  return (
    <View style={styles.center}>
      <Text style={styles.muted}>You&apos;re offline. Product management needs a connection.</Text>
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
    gap: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  title: { color: colors.text, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  price: { color: colors.text, fontSize: fontSize.md, fontWeight: fontWeight.semibold },
  input: {
    backgroundColor: colors.background,
    borderRadius: 8,
    padding: spacing.sm,
    color: colors.text,
    fontSize: fontSize.md,
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', gap: spacing.sm },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  secondary: { backgroundColor: colors.background },
  buttonLabel: { color: '#fff', fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  linkButton: { marginTop: spacing.xs },
  link: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  danger: { color: colors.error, fontSize: fontSize.sm },
  form: { gap: spacing.sm, marginTop: spacing.sm },
  error: { color: colors.error, fontSize: fontSize.sm },
});
