// Phase 30 — checkout: shipping address form, one-store order review,
// then payment. The mock provider completes instantly in dev; production
// providers redirect or poll — confirmPayment verifies with the provider,
// never trusting the client. Idempotency keys are minted per attempt.

import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TextInput } from '../../components';
import { useAuth } from '../../auth';
import {
  cancelOrder,
  checkout,
  confirmPayment,
  devCompleteMockPayment,
  getCart,
  getOrder,
  type Cart,
  type Order,
  type ShippingAddress,
} from '../../api/commerce';
import { colors, fontSize, fontWeight, spacing } from '../../theme';
import { EmptyState, ErrorState, LoadingState, Price, OfflineNotice } from '../../commerce/ui';
import { useOnline } from '../../commerce/useOnline';
import { randomUUID } from 'expo-crypto';

type Phase = 'form' | 'paying' | 'failed';

const EMPTY_ADDRESS: ShippingAddress = {
  name: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
};

export default function CheckoutScreen() {
  const { api: client } = useAuth();
  const online = useOnline();
  const [cart, setCart] = useState<Cart | null>(null);
  const [address, setAddress] = useState<ShippingAddress>(EMPTY_ADDRESS);
  const [phase, setPhase] = useState<Phase>('form');
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [failedOrder, setFailedOrder] = useState<Order | null>(null);

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

  const set = (key: keyof ShippingAddress, value: string) =>
    setAddress((a) => ({ ...a, [key]: value }));

  const valid =
    address.name.trim() &&
    address.line1.trim() &&
    address.city.trim() &&
    address.region.trim() &&
    address.postalCode.trim() &&
    /^[A-Za-z]{2}$/.test(address.country.trim());

  const pay = async () => {
    if (!valid) return;
    setPhase('paying');
    setError('');
    setFailedOrder(null);
    let orderId: string | null = null;
    try {
      const result = await checkout(client, randomUUID(), {
        ...address,
        country: address.country.trim().toUpperCase(),
      });
      orderId = result.order.id;
      // Dev only: the mock provider needs the buyer to "complete" payment
      // in its UI before confirm-payment will verify. Production providers
      // redirect to their own UI instead.
      if (__DEV__) {
        try {
          await devCompleteMockPayment(client, result.clientData.providerPaymentId);
        } catch {
          // Not a mock backend (404) — proceed to confirm anyway.
        }
      }
      const paid = await confirmPayment(client, orderId);
      router.replace(`/(commerce)/order/${paid.id}`);
    } catch (e) {
      // Checkout created an unpaid order before the payment failed; keep it
      // so the buyer can retry or cancel from the order screen.
      const message = e instanceof Error ? e.message : 'Payment failed.';
      setError(message);
      setPhase('failed');
      if (orderId) {
        // Fetch the unpaid order so the retry/cancel UI has something to act on.
        try {
          setFailedOrder(await getOrder(client, orderId));
        } catch {
          // Order fetch failed; the orders screen still lists it.
        }
      }
    }
  };

  if (!online) return <OfflineNotice />;
  if (state === 'loading') return <LoadingState />;
  if (state === 'error') return <ErrorState message={error} onRetry={() => void load()} />;
  if (!cart || cart.items.length === 0) {
    return <EmptyState label="Your cart is empty." />;
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Shipping address
      </Text>
      {(
        [
          ['name', 'Full name', true],
          ['line1', 'Street address', true],
          ['line2', 'Apt, suite, etc. (optional)', false],
          ['city', 'City', true],
          ['region', 'State / province', true],
          ['postalCode', 'Postal code', true],
          ['country', 'Country (2-letter code)', true],
        ] as const
      ).map(([key, label, required]) => (
        <TextInput
          key={key}
          label={label}
          required={required}
          placeholder={label}
          placeholderTextColor={colors.textMuted}
          accessibilityHint={
            key === 'country' ? 'Two letter country code, for example US' : undefined
          }
          value={address[key]}
          onChangeText={(v) => set(key, v)}
          autoCapitalize={key === 'country' ? 'characters' : 'words'}
          maxLength={key === 'country' ? 2 : 200}
        />
      ))}

      <Text style={styles.sectionTitle}>Order</Text>
      {cart.items.map((item) => (
        <View key={item.id} style={styles.line}>
          <Text style={styles.lineTitle} numberOfLines={1}>
            {item.product.title}
            {item.variant ? ` — ${item.variant.name}` : ''} × {item.quantity}
          </Text>
          <Price
            cents={(item.variant?.priceCents ?? item.product.priceCents) * item.quantity}
            currency={item.product.currency}
          />
        </View>
      ))}

      {error ? (
        <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          {error}
        </Text>
      ) : null}

      <Pressable
        style={[styles.pay, (!valid || phase === 'paying') && styles.disabled]}
        onPress={() => void pay()}
        disabled={!valid || phase === 'paying'}
        accessibilityRole="button"
        accessibilityLabel={phase === 'paying' ? 'Processing payment' : 'Pay now'}
        accessibilityState={{ disabled: !valid || phase === 'paying', busy: phase === 'paying' }}
        accessibilityHint="Completes the purchase for the items in your cart"
      >
        <Text style={styles.payLabel}>{phase === 'paying' ? 'Processing…' : 'Pay now'}</Text>
      </Pressable>
      <Text style={styles.hint}>
        One order per store. Unpaid orders can be retried or canceled from the order screen.
      </Text>
      {failedOrder ? (
        <Pressable
          style={styles.secondary}
          accessibilityRole="button"
          accessibilityLabel="Cancel unpaid order"
          onPress={async () => {
            await cancelOrder(client, failedOrder.id);
            void load();
            setFailedOrder(null);
            setPhase('form');
          }}
        >
          <Text style={styles.secondaryLabel}>Cancel unpaid order</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, gap: spacing.sm },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    marginTop: spacing.sm,
  },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  lineTitle: { color: colors.text, fontSize: fontSize.sm, flex: 1 },
  error: { color: colors.error, fontSize: fontSize.sm },
  pay: {
    backgroundColor: colors.primaryFilled,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  disabled: { opacity: 0.5 },
  payLabel: {
    color: colors.onPrimary,
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
  },
  hint: { color: colors.textMuted, fontSize: fontSize.xs, textAlign: 'center' },
  secondary: {
    borderWidth: 1,
    borderColor: colors.textMuted,
    borderRadius: 12,
    padding: spacing.md,
    alignItems: 'center',
  },
  secondaryLabel: { color: colors.text, fontSize: fontSize.md },
});
