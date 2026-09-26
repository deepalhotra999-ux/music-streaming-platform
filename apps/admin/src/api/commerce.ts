// Phase 30 — admin commerce API wrappers: store/product moderation,
// order visibility, and commerce reports. Admin-only; the backend
// enforces ADMIN role on every endpoint.

import type { ApiClient } from './client';

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

export interface AdminStore {
  id: string;
  artistId: string;
  name: string;
  status: StoreStatus;
  currency: string;
  createdAt: string;
}

export interface AdminProduct {
  id: string;
  storeId: string;
  title: string;
  status: ProductStatus;
  priceCents: number;
  currency: string;
  createdAt: string;
}

export interface AdminOrder {
  id: string;
  orderNumber: string;
  storeId: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  createdAt: string;
}

export interface CommerceStats {
  storeCount: number;
  activeStoreCount: number;
  productCount: number;
  activeProductCount: number;
  orderCount: number;
  paidOrderCount: number;
  grossCentsByCurrency: Record<string, number>;
  refundedCentsByCurrency: Record<string, number>;
}

export interface Page<T> {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

function qs(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function listAdminStores(
  client: ApiClient,
  params: { status?: StoreStatus; q?: string; page?: number; limit?: number } = {},
): Promise<Page<AdminStore>> {
  return client.get<Page<AdminStore>>(`/v1/admin/commerce/stores${qs(params)}`);
}

export function moderateStore(
  client: ApiClient,
  storeId: string,
  action: 'suspend' | 'reinstate',
): Promise<AdminStore> {
  return client.post<AdminStore>(`/v1/admin/commerce/stores/${storeId}/moderate`, { action });
}

export function listAdminProducts(
  client: ApiClient,
  params: { status?: ProductStatus; q?: string; page?: number; limit?: number } = {},
): Promise<Page<AdminProduct>> {
  return client.get<Page<AdminProduct>>(`/v1/admin/commerce/products${qs(params)}`);
}

export function moderateProduct(
  client: ApiClient,
  productId: string,
  action: 'remove' | 'restore',
): Promise<AdminProduct> {
  return client.post<AdminProduct>(`/v1/admin/commerce/products/${productId}/moderate`, {
    action,
  });
}

export function listAdminOrders(
  client: ApiClient,
  params: { status?: OrderStatus; page?: number; limit?: number } = {},
): Promise<Page<AdminOrder>> {
  return client.get<Page<AdminOrder>>(`/v1/admin/commerce/orders${qs(params)}`);
}

export function getCommerceStats(client: ApiClient): Promise<CommerceStats> {
  return client.get<CommerceStats>('/v1/admin/commerce/stats');
}
