// Phase 19 — purchase flow tests.
//
// Verifies the mobile purchase state machine: products load from the
// server, purchases go through the store then server verification, and
// — critically — a store purchase callback alone NEVER grants
// entitlement. Entitlement only changes when the backend verifies the
// purchase and the client refreshes server state.

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { usePurchaseFlow } from '../purchases';
import type { ApiClient } from '../../api';

// --- Mocks -----------------------------------------------------------------

const mockProducts = [
  {
    planCode: 'premium_individual',
    planName: 'Premium Individual',
    planType: 'INDIVIDUAL' as const,
    appleProductId: 'com.waveform.test.premium.individual',
    googleProductId: 'waveform.test.premium.individual',
  },
];

function createMockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    get: jest.fn(async (path: string) => {
      if (path === '/v1/subscriptions/products') {
        return { products: mockProducts, appleConfigured: true, googleConfigured: true };
      }
      throw new Error(`Unexpected GET ${path}`);
    }),
    post: jest.fn(async (path: string) => {
      if (path === '/v1/subscriptions/verify-purchase') {
        return {
          subscription: { id: 'sub-1', planId: 'plan-1', provider: 'apple', status: 'ACTIVE' },
          created: true,
        };
      }
      throw new Error(`Unexpected POST ${path}`);
    }),
    // Unused in these tests.
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as ApiClient;
}

interface MockIap {
  initConnection: jest.Mock;
  fetchProducts: jest.Mock;
  requestPurchase: jest.Mock;
  getAvailablePurchases: jest.Mock;
  finishTransaction: jest.Mock;
  purchaseUpdatedListener: jest.Mock;
  purchaseErrorListener: jest.Mock;
  // Captured listeners for driving callbacks.
  updatedCb: ((p: unknown) => void) | null;
  errorCb: ((e: unknown) => void) | null;
}

function createMockIap(): MockIap {
  const mock: MockIap = {
    initConnection: jest.fn(async () => {}),
    fetchProducts: jest.fn(async () => [
      { id: 'com.waveform.test.premium.individual', displayPrice: '$9.99' },
    ]),
    requestPurchase: jest.fn(async () => {}),
    getAvailablePurchases: jest.fn(async () => []),
    finishTransaction: jest.fn(async () => {}),
    purchaseUpdatedListener: jest.fn(),
    purchaseErrorListener: jest.fn(),
    updatedCb: null,
    errorCb: null,
  };
  mock.purchaseUpdatedListener.mockImplementation((cb: (p: unknown) => void) => {
    mock.updatedCb = cb;
    return { remove: jest.fn() };
  });
  mock.purchaseErrorListener.mockImplementation((cb: (e: unknown) => void) => {
    mock.errorCb = cb;
    return { remove: jest.fn() };
  });
  return mock;
}

// Force iOS for deterministic provider selection in these tests.
const originalOS = Platform.OS;
beforeAll(() => {
  Object.defineProperty(Platform, 'OS', { get: () => 'ios', configurable: true });
});
afterAll(() => {
  Object.defineProperty(Platform, 'OS', { get: () => originalOS, configurable: true });
});

describe('usePurchaseFlow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads products from the server (never hard-coded SKUs)', async () => {
    const api = createMockApi();
    const iap = createMockIap();
    const { result } = renderHook(() => usePurchaseFlow(api, undefined, { iap }));

    expect(result.current.state).toBe('idle');

    await act(async () => {
      result.current.load();
    });

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.products).toEqual(mockProducts);
    expect(iap.fetchProducts).toHaveBeenCalledWith({
      skus: ['com.waveform.test.premium.individual'],
      type: 'subs',
    });
  });

  it('a store purchase callback triggers server verification, not local entitlement', async () => {
    const api = createMockApi();
    const iap = createMockIap();
    let verified = false;
    const onVerified = jest.fn(() => {
      verified = true;
    });
    const { result } = renderHook(() => usePurchaseFlow(api, onVerified, { iap }));

    await act(async () => {
      result.current.load();
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    // Start a purchase.
    await act(async () => {
      result.current.purchase('com.waveform.test.premium.individual');
    });
    expect(result.current.state).toBe('purchasing');
    expect(iap.requestPurchase).toHaveBeenCalled();

    // The store fires the purchase callback. The hook must NOT mark
    // success yet — it must first verify with the server.
    const fakePurchase = { transactionId: 'txn-123' };
    await act(async () => {
      iap.updatedCb?.(fakePurchase);
    });

    // Verification calls the backend with the store token…
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/v1/subscriptions/verify-purchase', {
        provider: 'apple',
        purchaseToken: 'txn-123',
      }),
    );
    // …finishes the transaction only AFTER verification…
    expect(iap.finishTransaction).toHaveBeenCalledWith({
      purchase: fakePurchase,
      isConsumable: false,
    });
    // …and only then reports success so the caller refreshes server state.
    await waitFor(() => expect(result.current.state).toBe('success'));
    expect(onVerified).toHaveBeenCalled();
    expect(verified).toBe(true);
  });

  it('a purchase callback with a rejected verification does NOT grant success', async () => {
    const api = createMockApi({
      post: jest.fn(async () => {
        throw new Error('Invalid purchase token');
      }),
    });
    const iap = createMockIap();
    const onVerified = jest.fn();
    const { result } = renderHook(() => usePurchaseFlow(api, onVerified, { iap }));

    await act(async () => {
      result.current.load();
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      result.current.purchase('com.waveform.test.premium.individual');
    });

    // Store says the purchase happened; server rejects it.
    await act(async () => {
      iap.updatedCb?.({ transactionId: 'txn-bad' });
    });

    await waitFor(() => expect(result.current.state).toBe('failed'));
    expect(result.current.error).toMatch(/Invalid purchase token/);
    // The transaction is NOT finished (token preserved for retry/debug).
    expect(iap.finishTransaction).not.toHaveBeenCalled();
    // The caller is NOT told to refresh — no entitlement change.
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('user cancellation is a distinct canceled state, not a failure', async () => {
    const api = createMockApi();
    const iap = createMockIap();
    const { result } = renderHook(() => usePurchaseFlow(api, undefined, { iap }));

    await act(async () => {
      result.current.load();
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    await act(async () => {
      result.current.purchase('com.waveform.test.premium.individual');
    });

    await act(async () => {
      iap.errorCb?.({ code: 'E_USER_CANCELLED', message: 'User cancelled' });
    });

    expect(result.current.state).toBe('canceled');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('restore sends each available purchase to the server for verification', async () => {
    const api = createMockApi();
    const iap = createMockIap();
    iap.getAvailablePurchases.mockResolvedValue([{ transactionId: 'txn-restore-1' }]);
    const onVerified = jest.fn();
    const { result } = renderHook(() => usePurchaseFlow(api, onVerified, { iap }));

    await act(async () => {
      result.current.restore();
    });

    await waitFor(() => expect(result.current.state).toBe('success'));
    expect(api.post).toHaveBeenCalledWith('/v1/subscriptions/verify-purchase', {
      provider: 'apple',
      purchaseToken: 'txn-restore-1',
    });
    expect(onVerified).toHaveBeenCalled();
  });

  it('restore with no purchases reports failure without touching the server', async () => {
    const api = createMockApi();
    const iap = createMockIap();
    iap.getAvailablePurchases.mockResolvedValue([]);
    const { result } = renderHook(() => usePurchaseFlow(api, undefined, { iap }));

    await act(async () => {
      result.current.restore();
    });

    await waitFor(() => expect(result.current.state).toBe('failed'));
    expect(result.current.error).toMatch(/No restorable purchases/);
    expect(api.post).not.toHaveBeenCalled();
  });
});
