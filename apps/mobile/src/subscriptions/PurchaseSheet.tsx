// Phase 19 — purchase sheet UI.
//
// Lists the server-configured store products, drives the expo-iap purchase
// flow via usePurchaseFlow, and surfaces pending/success/failed/canceled/
// restored states. The sheet NEVER grants entitlement itself — it only
// displays what the server reports after verification.

import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Platform } from 'react-native';
import { Button } from '../components';
import { colors, fontSize, fontWeight, radii, spacing } from '../theme';
import type { PurchaseFlowResult } from './purchases';

interface PurchaseSheetProps {
  flow: PurchaseFlowResult;
  onClose: () => void;
}

const PLAN_TYPE_LABEL: Record<string, string> = {
  INDIVIDUAL: 'Individual',
  FAMILY: 'Family',
  STUDENT: 'Student',
};

export function PurchaseSheet({ flow, onClose }: PurchaseSheetProps) {
  const { state, products, storeDetails, error, load, purchase, restore, reset } = flow;

  // Load products when the sheet opens.
  // (The parent mounts this sheet conditionally; load on first render.)
  if (state === 'idle') {
    load();
  }

  const handleClose = () => {
    reset();
    onClose();
  };

  return (
    <View style={styles.container} testID="purchase-sheet">
      <View style={styles.header}>
        <Text style={styles.title}>Choose a plan</Text>
        <Button title="Close" variant="secondary" onPress={handleClose} testID="purchase-close" />
      </View>

      {state === 'loading-products' && (
        <View style={styles.center} testID="purchase-loading">
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.muted}>Loading plans…</Text>
        </View>
      )}

      {state === 'failed' && !products && (
        <View style={styles.center} testID="purchase-error">
          <Ionicons name="alert-circle-outline" size={32} color={colors.error} />
          <Text style={styles.errorText}>Couldn&apos;t load plans.</Text>
          <Text style={styles.muted}>{error}</Text>
          <Button title="Retry" variant="secondary" onPress={load} testID="purchase-retry" />
        </View>
      )}

      {(state === 'ready' ||
        state === 'purchasing' ||
        state === 'verifying' ||
        state === 'canceled' ||
        state === 'restoring' ||
        (state === 'failed' && products)) &&
        products && (
          <View testID="purchase-products">
            {products.map((p) => {
              const sku = Platform.OS === 'ios' ? p.appleProductId : p.googleProductId;
              const detail = sku ? storeDetails[sku] : undefined;
              const busy = state === 'purchasing' || state === 'verifying';
              return (
                <View key={p.planCode} style={styles.productCard} testID={`product-${p.planCode}`}>
                  <View style={styles.productHeader}>
                    <Text style={styles.productName}>{p.planName}</Text>
                    <Text style={styles.productType}>
                      {PLAN_TYPE_LABEL[p.planType] ?? p.planType}
                    </Text>
                  </View>
                  {detail && <Text style={styles.price}>{detail.displayPrice}</Text>}
                  {!sku && <Text style={styles.muted}>Not available on this platform.</Text>}
                  {sku && (
                    <Button
                      title={busy ? 'Processing…' : `Subscribe`}
                      onPress={() => purchase(sku)}
                      disabled={busy}
                      testID={`purchase-${p.planCode}`}
                    />
                  )}
                </View>
              );
            })}

            {state === 'purchasing' && (
              <View style={styles.statusRow} testID="purchase-pending">
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.muted}>
                  Waiting for the store… complete the purchase in the system sheet.
                </Text>
              </View>
            )}
            {state === 'verifying' && (
              <View style={styles.statusRow} testID="purchase-verifying">
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.muted}>Verifying with the server…</Text>
              </View>
            )}
            {state === 'canceled' && (
              <View style={styles.statusRow} testID="purchase-canceled">
                <Ionicons name="close-circle-outline" size={20} color={colors.textMuted} />
                <Text style={styles.muted}>Purchase canceled. No charge was made.</Text>
              </View>
            )}
            {state === 'failed' && error && (
              <View style={styles.statusRow} testID="purchase-failed">
                <Ionicons name="alert-circle-outline" size={20} color={colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <View style={styles.restoreRow}>
              <Button
                title="Restore purchases"
                variant="secondary"
                onPress={restore}
                disabled={state === 'purchasing' || state === 'verifying' || state === 'restoring'}
                testID="purchase-restore"
              />
            </View>
            {state === 'restoring' && (
              <View style={styles.statusRow} testID="purchase-restoring">
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.muted}>Checking for previous purchases…</Text>
              </View>
            )}
          </View>
        )}

      {state === 'success' && (
        <View style={styles.center} testID="purchase-success">
          <Ionicons name="checkmark-circle" size={48} color={colors.success} />
          <Text style={styles.successTitle}>You&apos;re subscribed!</Text>
          <Text style={styles.muted}>
            Your purchase was verified. Premium features are now unlocked.
          </Text>
          <Button title="Done" onPress={handleClose} testID="purchase-done" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  center: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  muted: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
  },
  errorText: {
    fontSize: fontSize.sm,
    color: colors.error,
    textAlign: 'center',
  },
  successTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  productCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  productHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  productName: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  productType: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
  },
  price: {
    fontSize: fontSize.sm,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  restoreRow: {
    marginTop: spacing.md,
    alignItems: 'center',
  },
});
