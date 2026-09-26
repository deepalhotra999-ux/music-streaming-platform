// Phase 30 — commerce API wrapper contract tests (mocked transport).

import {
  addToCart,
  cancelOrder,
  checkout,
  confirmPayment,
  devCompleteMockPayment,
  formatPrice,
  getCart,
  getOrder,
  getProduct,
  getStore,
  listOrders,
  listStoreProducts,
  listStores,
} from '../commerce';
import type { ApiClient } from '../client';

function mockClient(impl: Partial<ApiClient> = {}): ApiClient {
  const fallback = {
    get: ((..._args: unknown[]) => {
      throw new Error('not mocked');
    }) as ApiClient['get'],
    post: ((..._args: unknown[]) => {
      throw new Error('not mocked');
    }) as ApiClient['post'],
    patch: ((..._args: unknown[]) => {
      throw new Error('not mocked');
    }) as ApiClient['patch'],
    delete: ((..._args: unknown[]) => {
      throw new Error('not mocked');
    }) as ApiClient['delete'],
  };
  return { ...fallback, ...impl } as ApiClient;
}

type GetFn = ApiClient['get'];
type PostFn = ApiClient['post'];

const getMock = (impl: (url: string) => unknown) =>
  jest.fn(impl) as unknown as GetFn;
const postMock = (impl: (url: string, body?: unknown) => unknown) =>
  jest.fn(impl) as unknown as PostFn;

describe('commerce api', () => {
  it('lists stores with query params', async () => {
    const get = getMock(async () => ({ data: [], pagination: {} }));
    await listStores(mockClient({ get }), { q: 'vinyl', page: 2, limit: 10 });
    expect(get).toHaveBeenCalledWith('/v1/commerce/stores?q=vinyl&page=2&limit=10');
  });

  it('fetches a store and its products', async () => {
    const get = getMock(async (url: string) =>
      url.includes('/products') ? { data: [], pagination: {} } : { id: 's1' },
    );
    const client = mockClient({ get });
    await getStore(client, 's1');
    await listStoreProducts(client, 's1', { limit: 5 });
    expect(get).toHaveBeenCalledWith('/v1/commerce/stores/s1');
    expect(get).toHaveBeenCalledWith('/v1/commerce/stores/s1/products?limit=5');
  });

  it('fetches a product', async () => {
    const get = getMock(async () => ({ id: 'p1' }));
    await getProduct(mockClient({ get }), 'p1');
    expect(get).toHaveBeenCalledWith('/v1/commerce/products/p1');
  });

  it('adds to cart with optional variant', async () => {
    const post = postMock(async () => ({ id: 'c1', items: [] }));
    const client = mockClient({ post });
    await addToCart(client, 'p1', 2);
    expect(post).toHaveBeenCalledWith('/v1/commerce/cart/items', {
      productId: 'p1',
      quantity: 2,
    });
    await addToCart(client, 'p1', 1, 'v1');
    expect(post).toHaveBeenCalledWith('/v1/commerce/cart/items', {
      productId: 'p1',
      quantity: 1,
      variantId: 'v1',
    });
  });

  it('reads the cart', async () => {
    const get = getMock(async () => ({ id: 'c1', items: [] }));
    await getCart(mockClient({ get }));
    expect(get).toHaveBeenCalledWith('/v1/commerce/cart');
  });

  it('checks out with an idempotency key and address', async () => {
    const post = postMock(async () => ({ order: { id: 'o1' } }));
    const address = {
      name: 'A',
      line1: '1 Main St',
      city: 'Toronto',
      region: 'ON',
      postalCode: 'M5V1A1',
      country: 'CA',
    };
    await checkout(mockClient({ post }), 'key-1', address);
    expect(post).toHaveBeenCalledWith('/v1/commerce/checkout', {
      idempotencyKey: 'key-1',
      shippingAddress: address,
    });
  });

  it('confirms payment and cancels orders', async () => {
    const post = postMock(async () => ({ id: 'o1' }));
    const client = mockClient({ post });
    await confirmPayment(client, 'o1');
    expect(post).toHaveBeenCalledWith('/v1/commerce/orders/o1/confirm-payment', {});
    await cancelOrder(client, 'o1');
    expect(post).toHaveBeenCalledWith('/v1/commerce/orders/o1/cancel', {});
  });

  it('lists and fetches orders', async () => {
    const get = getMock(async () => ({ data: [], pagination: {} }));
    const client = mockClient({ get });
    await listOrders(client, { status: 'PAID' });
    expect(get).toHaveBeenCalledWith('/v1/commerce/orders?status=PAID');
    await getOrder(client, 'o1');
    expect(get).toHaveBeenCalledWith('/v1/commerce/orders/o1');
  });

  it('completes mock payment in dev', async () => {
    const post = getMock(async () => ({ ok: true }));
    const client = mockClient({ post });
    await devCompleteMockPayment(client, 'pay_123');
    expect(post).toHaveBeenCalledWith('/v1/dev/commerce/complete-payment', {
      providerPaymentId: 'pay_123',
    });
  });

  it('formats prices', () => {
    expect(formatPrice(2500, 'USD')).toBe('$25.00');
    expect(formatPrice(0, 'USD')).toBe('$0.00');
  });
});
