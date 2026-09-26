// Phase 30 — commerce API wrapper contract tests (mocked client).

import { describe, expect, it, vi } from 'vitest';
import {
  getCommerceStats,
  listAdminOrders,
  listAdminProducts,
  listAdminStores,
  moderateProduct,
  moderateStore,
} from '../api/commerce';
import type { ApiClient } from '../api/client';

function mockClient(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient;
}

describe('admin commerce api', () => {
  it('lists stores with filters', async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    await listAdminStores(client, { status: 'SUSPENDED', q: 'vinyl', page: 2 });
    expect(client.get).toHaveBeenCalledWith(
      '/v1/admin/commerce/stores?status=SUSPENDED&q=vinyl&page=2',
    );
  });

  it('suspends and reinstates a store', async () => {
    const client = mockClient();
    (client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 's1' });
    await moderateStore(client, 's1', 'suspend');
    expect(client.post).toHaveBeenCalledWith('/v1/admin/commerce/stores/s1/moderate', {
      action: 'suspend',
    });
    await moderateStore(client, 's1', 'reinstate');
    expect(client.post).toHaveBeenCalledWith('/v1/admin/commerce/stores/s1/moderate', {
      action: 'reinstate',
    });
  });

  it('lists products and moderates them', async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    await listAdminProducts(client, { status: 'ACTIVE' });
    expect(client.get).toHaveBeenCalledWith('/v1/admin/commerce/products?status=ACTIVE');

    (client.post as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'p1' });
    await moderateProduct(client, 'p1', 'remove');
    expect(client.post).toHaveBeenCalledWith('/v1/admin/commerce/products/p1/moderate', {
      action: 'remove',
    });
    await moderateProduct(client, 'p1', 'restore');
    expect(client.post).toHaveBeenCalledWith('/v1/admin/commerce/products/p1/moderate', {
      action: 'restore',
    });
  });

  it('lists orders and fetches stats', async () => {
    const client = mockClient();
    (client.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    await listAdminOrders(client, { status: 'PAID', page: 1 });
    expect(client.get).toHaveBeenCalledWith('/v1/admin/commerce/orders?status=PAID&page=1');

    await getCommerceStats(client);
    expect(client.get).toHaveBeenCalledWith('/v1/admin/commerce/stats');
  });
});
