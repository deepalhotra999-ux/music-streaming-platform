// Phase 30 — artist commerce API wrappers.
//
// Thin typed wrappers over the Phase 30 commerce endpoints. Every call
// requires an authenticated client except the public storefront reads;
// the backend enforces ARTIST ownership, ADMIN moderation rights, and
// buyer-only order access — the client sends no authorization logic of
// its own. Prices are server-authoritative; the client never computes
// totals. Commerce requires connectivity: no offline support.

import type { ApiClient } from './client';
import type { Page } from './types';

export type StoreStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'SUSPENDED';
export type ProductStatus =
  | 'DRAFT'
  | 'ACTIVE'
  | 'PAUSED'
  | 'SOLD_OUT'
  | 'ARCHIVED'
  | 'REMOVED';
export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELED'
  | 'REFUNDED';
export type FulfillmentStatus =
  | 'UNFULFILLED'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED';

export interface Store {
  id: string;
  artistId: string;
  name: string;
  description: string | null;
  currency: string;
  status: StoreStatus;
  imageUrl: string | null;
  bannerUrl: string | null;
  shippingFlatCents: number;
}

export interface ProductVariant {
  id: string;
  name: string;
  sku: string | null;
  priceCents: number;
  currency: string;
  availableQuantity: number;
}

export interface ProductImage {
  id: string;
  imageUrl: string;
  altText: string | null;
  sortOrder: number;
}

export interface Product {
  id: string;
  storeId: string;
  title: string;
  description: string | null;
  priceCents: number;
  currency: string;
  status: ProductStatus;
  images: ProductImage[];
  variants: ProductVariant[];
}

export interface InventoryRow {
  productId: string;
  variantId: string | null;
  quantityAvailable: number;
  quantityReserved: number;
  quantitySold: number;
}

export interface CartItem {
  id: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  product: Pick<Product, 'id' | 'title' | 'priceCents' | 'currency' | 'status'>;
  variant: Pick<ProductVariant, 'id' | 'name' | 'priceCents'> | null;
}

export interface CartStoreGroup {
  storeId: string;
  storeName: string;
  items: CartItem[];
}

export interface Cart {
  id: string;
  items: CartItem[];
  storeGroups: CartStoreGroup[];
}

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface OrderItem {
  id: string;
  productTitle: string;
  variantName: string | null;
  quantity: number;
  unitPriceCents: number;
  currency: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  storeId: string;
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  items: OrderItem[];
  trackingNumber: string | null;
  createdAt: string;
}

export interface Refund {
  id: string;
  orderId: string;
  amountCents: number;
  currency: string;
  status: string;
}

// ------------------------------------------------------------ storefront ---

export async function listStores(
  client: ApiClient,
  params: { q?: string; page?: number; limit?: number } = {},
): Promise<Page<Store>> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return client.get<Page<Store>>(`/v1/commerce/stores${qs ? `?${qs}` : ''}`);
}

export async function getStore(client: ApiClient, storeId: string): Promise<Store> {
  return client.get<Store>(`/v1/commerce/stores/${storeId}`);
}

export async function listStoreProducts(
  client: ApiClient,
  storeId: string,
  params: { page?: number; limit?: number } = {},
): Promise<Page<Product>> {
  const query = new URLSearchParams();
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return client.get<Page<Product>>(
    `/v1/commerce/stores/${storeId}/products${qs ? `?${qs}` : ''}`,
  );
}

export async function getProduct(client: ApiClient, productId: string): Promise<Product> {
  return client.get<Product>(`/v1/commerce/products/${productId}`);
}

// ----------------------------------------------------------------- cart ---

export async function getCart(client: ApiClient): Promise<Cart> {
  return client.get<Cart>('/v1/commerce/cart');
}

export async function addToCart(
  client: ApiClient,
  productId: string,
  quantity: number,
  variantId?: string,
): Promise<Cart> {
  return client.post<Cart>('/v1/commerce/cart/items', {
    productId,
    quantity,
    ...(variantId ? { variantId } : {}),
  });
}

export async function updateCartItem(
  client: ApiClient,
  itemId: string,
  quantity: number,
): Promise<Cart> {
  return client.patch<Cart>(`/v1/commerce/cart/items/${itemId}`, { quantity });
}

export async function removeCartItem(client: ApiClient, itemId: string): Promise<Cart> {
  return client.delete<Cart>(`/v1/commerce/cart/items/${itemId}`);
}

// ------------------------------------------------------------- checkout ---

export interface CheckoutResult {
  order: Order;
  created: boolean;
  clientData: { providerPaymentId: string };
}

export async function checkout(
  client: ApiClient,
  idempotencyKey: string,
  shippingAddress: ShippingAddress,
): Promise<CheckoutResult> {
  return client.post<CheckoutResult>('/v1/commerce/checkout', {
    idempotencyKey,
    shippingAddress,
  });
}

export async function confirmPayment(client: ApiClient, orderId: string): Promise<Order> {
  return client.post<Order>(`/v1/commerce/orders/${orderId}/confirm-payment`, {});
}

/**
 * Dev-only: simulates the buyer completing payment in the provider UI.
 * The mock provider requires this before confirm-payment will succeed.
 * No-op in production (endpoint returns 404 unless mock is configured).
 */
export async function devCompleteMockPayment(
  client: ApiClient,
  providerPaymentId: string,
): Promise<void> {
  await client.post('/v1/dev/commerce/complete-payment', { providerPaymentId });
}

export async function retryPayment(client: ApiClient, orderId: string): Promise<Order> {
  return client.post<Order>(`/v1/commerce/orders/${orderId}/retry-payment`, {});
}

export async function cancelOrder(client: ApiClient, orderId: string): Promise<Order> {
  return client.post<Order>(`/v1/commerce/orders/${orderId}/cancel`, {});
}

// --------------------------------------------------------------- orders ---

export async function listOrders(
  client: ApiClient,
  params: { status?: OrderStatus; page?: number; limit?: number } = {},
): Promise<Page<Order>> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return client.get<Page<Order>>(`/v1/commerce/orders${qs ? `?${qs}` : ''}`);
}

export async function getOrder(client: ApiClient, orderId: string): Promise<Order> {
  return client.get<Order>(`/v1/commerce/orders/${orderId}`);
}

// -------------------------------------------------- artist management ---

export async function listStoreOrders(
  client: ApiClient,
  storeId: string,
  params: { status?: OrderStatus; page?: number; limit?: number } = {},
): Promise<Page<Order>> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  return client.get<Page<Order>>(
    `/v1/commerce/stores/${storeId}/orders${qs ? `?${qs}` : ''}`,
  );
}

export async function createStore(
  client: ApiClient,
  input: {
    artistId: string;
    name: string;
    description?: string;
    currency: string;
    shippingFlatCents?: number;
  },
): Promise<Store> {
  return client.post<Store>('/v1/commerce/stores', input);
}

export async function updateStore(
  client: ApiClient,
  storeId: string,
  input: Partial<Pick<Store, 'name' | 'description' | 'status' | 'shippingFlatCents'>>,
): Promise<Store> {
  return client.patch<Store>(`/v1/commerce/stores/${storeId}`, input);
}

export async function getMyStore(client: ApiClient, artistId: string): Promise<Store> {
  return client.get<Store>(`/v1/commerce/artists/${artistId}/store`);
}

export async function createProduct(
  client: ApiClient,
  input: {
    storeId: string;
    title: string;
    description?: string;
    priceCents: number;
    status?: ProductStatus;
  },
): Promise<Product> {
  return client.post<Product>('/v1/commerce/products', input);
}

export async function updateProduct(
  client: ApiClient,
  productId: string,
  input: Partial<Pick<Product, 'title' | 'description' | 'priceCents' | 'status'>>,
): Promise<Product> {
  return client.patch<Product>(`/v1/commerce/products/${productId}`, input);
}

export async function archiveProduct(client: ApiClient, productId: string): Promise<Product> {
  return client.post<Product>(`/v1/commerce/products/${productId}/archive`, {});
}

export async function createVariant(
  client: ApiClient,
  productId: string,
  input: { name: string; sku?: string; priceCents: number },
): Promise<ProductVariant> {
  return client.post<ProductVariant>(`/v1/commerce/products/${productId}/variants`, input);
}

export async function updateVariant(
  client: ApiClient,
  productId: string,
  variantId: string,
  input: Partial<Pick<ProductVariant, 'name' | 'sku' | 'priceCents'>>,
): Promise<ProductVariant> {
  return client.patch<ProductVariant>(
    `/v1/commerce/products/${productId}/variants/${variantId}`,
    input,
  );
}

export async function deleteVariant(
  client: ApiClient,
  productId: string,
  variantId: string,
): Promise<void> {
  await client.delete(`/v1/commerce/products/${productId}/variants/${variantId}`);
}

export async function addProductImage(
  client: ApiClient,
  productId: string,
  imageUrl: string,
  altText?: string,
): Promise<ProductImage> {
  return client.post<ProductImage>(`/v1/commerce/products/${productId}/images`, {
    imageUrl,
    ...(altText ? { altText } : {}),
  });
}

export async function reorderProductImages(
  client: ApiClient,
  productId: string,
  imageIds: string[],
): Promise<ProductImage[]> {
  return client.post<ProductImage[]>(
    `/v1/commerce/products/${productId}/images/reorder`,
    { imageIds },
  );
}

export async function removeProductImage(client: ApiClient, imageId: string): Promise<void> {
  await client.delete(`/v1/commerce/products/images/${imageId}`);
}

export async function getInventory(
  client: ApiClient,
  productId: string,
): Promise<InventoryRow[]> {
  const res = await client.get<{ inventory: InventoryRow[] }>(
    `/v1/commerce/products/${productId}/inventory`,
  );
  return res.inventory;
}

export async function setInventory(
  client: ApiClient,
  productId: string,
  quantityAvailable: number,
  variantId?: string,
): Promise<InventoryRow[]> {
  const res = await client.post<{ inventory: InventoryRow[] }>(
    `/v1/commerce/products/${productId}/inventory`,
    { quantityAvailable, ...(variantId ? { variantId } : {}) },
  );
  return res.inventory;
}

export async function updateFulfillment(
  client: ApiClient,
  orderId: string,
  input: { fulfillmentStatus: FulfillmentStatus; trackingNumber?: string },
): Promise<Order> {
  return client.post<Order>(`/v1/commerce/orders/${orderId}/fulfillment`, input);
}

export async function refundOrder(
  client: ApiClient,
  orderId: string,
  idempotencyKey: string,
  reason?: string,
): Promise<Refund> {
  return client.post<Refund>(`/v1/commerce/orders/${orderId}/refund`, {
    idempotencyKey,
    ...(reason ? { reason } : {}),
  });
}

/** Format minor units as a display string, e.g. 2500 + "USD" -> "$25.00". */
export function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}
