// Phase 30 — commerce stack: public storefront, cart, checkout, and
// order history. Sibling of (tabs) and (catalog) in the root stack; the
// tab bar is hidden here and the native header provides back navigation.
// Commerce requires connectivity — screens show an offline notice when
// the device is offline (no offline commerce).

import { Stack } from 'expo-router';
import { colors, fontWeight } from '../../theme';

export default function CommerceLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.tabBar },
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: fontWeight.semibold },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="stores" options={{ title: 'Artist stores' }} />
      <Stack.Screen name="store/[storeId]" options={{ title: 'Store' }} />
      <Stack.Screen name="product/[productId]" options={{ title: 'Product' }} />
      <Stack.Screen name="cart" options={{ title: 'Cart' }} />
      <Stack.Screen name="checkout" options={{ title: 'Checkout' }} />
      <Stack.Screen name="orders" options={{ title: 'My orders' }} />
      <Stack.Screen name="order/[orderId]" options={{ title: 'Order' }} />
    </Stack>
  );
}
