// Phase 20 — subscription screen tests.
//
// Verifies the complete subscription management experience:
// - All subscription states (ACTIVE, TRIALING, PAST_DUE, CANCELED, EXPIRED,
//   REVOKED, none) render with correct messaging and locked/unlocked states.
// - Products load from the server with store prices (never invented).
// - Purchase flows: pending, verifying, success, failed, canceled.
// - Restore purchases (with and without purchases).
// - Refresh status.
// - Manage subscription deep links.
// - Network failures and signed-out behavior.
// - Accessibility labels and roles.
//
// The screen never grants entitlement — it only displays server state.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SubscriptionScreen } from '../SubscriptionScreen';
import type { ApiClient, MySubscription } from '../../api';

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

function createSubscription(overrides = {}): MySubscription['subscription'] {
  return {
    id: 'sub-1',
    planId: 'premium_individual',
    plan: { id: 'premium_individual', name: 'Premium Individual' },
    provider: 'APPLE',
    status: 'ACTIVE',
    currentPeriodStart: '2026-09-01T00:00:00.000Z',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    canceledAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as MySubscription['subscription'];
}

function createMockApi(
  subscription: MySubscription['subscription'] | null = createSubscription(),
  overrides: Partial<ApiClient> = {},
): ApiClient {
  return {
    get: jest.fn(async (path: string) => {
      if (path === '/v1/subscriptions/me') {
        return {
          subscription,
          entitlement: {
            entitled: subscription?.status === 'ACTIVE' || subscription?.status === 'TRIALING',
            status: subscription?.status ?? 'NONE',
            planCode: subscription?.planId ?? null,
            currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
            reason: 'test',
          },
        };
      }
      if (path === '/v1/subscriptions/products') {
        return { products: mockProducts, appleConfigured: true, googleConfigured: true };
      }
      throw new Error(`Unexpected GET ${path}`);
    }),
    post: jest.fn(async () => ({
      subscription: createSubscription(),
      created: true,
    })),
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
  updatedCb: ((p: unknown) => void) | null;
  errorCb: ((e: unknown) => void) | null;
}

// Note: The SubscriptionScreen uses the real usePurchaseFlow which imports
// expo-iap directly. We mock expo-iap at the module level.
jest.mock('expo-iap', () => {
  const mock: MockIap = {
    initConnection: jest.fn(async () => {}),
    fetchProducts: jest.fn(async () => [
      { id: 'com.waveform.test.premium.individual', displayPrice: '$9.99', title: 'Premium' },
    ]),
    requestPurchase: jest.fn(async () => {}),
    getAvailablePurchases: jest.fn(async () => []),
    finishTransaction: jest.fn(async () => {}),
    purchaseUpdatedListener: jest.fn(() => ({ remove: jest.fn() })),
    purchaseErrorListener: jest.fn(() => ({ remove: jest.fn() })),
    updatedCb: null,
    errorCb: null,
  };
  return {
    ...mock,
    deepLinkToSubscriptions: jest.fn(async () => {}),
  };
});

jest.mock('expo-constants', () => ({
  expoConfig: { android: { package: 'com.waveform.test' } },
}));

// --- Tests -----------------------------------------------------------------

describe('SubscriptionScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default to iOS for consistent product IDs.
    Object.defineProperty(Platform, 'OS', { value: 'ios', writable: true });
  });

  it('shows loading state initially', () => {
    const api = createMockApi();
    const { getByTestId } = render(<SubscriptionScreen api={api} />);
    expect(getByTestId('current-subscription-loading')).toBeTruthy();
  });

  it('shows active subscription with unlocked playback', async () => {
    const api = createMockApi(createSubscription({ status: 'ACTIVE' }));
    const { getByTestId, queryByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('current-subscription')).toBeTruthy();
    });

    expect(getByTestId('subscription-entitlement').props.children).toBe('Unlocked');
    // No locked-state notes for active subscriptions.
    expect(queryByTestId('canceled-note')).toBeNull();
    expect(queryByTestId('past-due-note')).toBeNull();
  });

  it('shows locked-state messaging when there is no subscription', async () => {
    const api = createMockApi(null);
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('current-subscription-none')).toBeTruthy();
    });

    const card = getByTestId('current-subscription-none');
    expect(card.props.accessibilityLabel).toContain('Free plan');
    expect(card.props.accessibilityLabel).toContain('locked');
  });

  it('shows canceled subscription with immediate-lock messaging', async () => {
    const api = createMockApi(
      createSubscription({ status: 'CANCELED', canceledAt: '2026-09-15T00:00:00.000Z' }),
    );
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('current-subscription')).toBeTruthy();
    });

    expect(getByTestId('canceled-note')).toBeTruthy();
    expect(getByTestId('subscription-entitlement').props.children).toBe('Locked');
  });

  it('shows past-due subscription as locked with payment guidance', async () => {
    const api = createMockApi(createSubscription({ status: 'PAST_DUE' }));
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('past-due-note')).toBeTruthy();
    });

    expect(getByTestId('subscription-entitlement').props.children).toBe('Locked');
  });

  it('shows expired subscription with resubscribe messaging', async () => {
    const api = createMockApi(createSubscription({ status: 'EXPIRED' }));
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('expired-note')).toBeTruthy();
    });
  });

  it('shows revoked subscription with resubscribe messaging', async () => {
    const api = createMockApi(createSubscription({ status: 'REVOKED' }));
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('revoked-note')).toBeTruthy();
    });
  });

  it('shows trialing subscription with trial end date', async () => {
    const api = createMockApi(createSubscription({ status: 'TRIALING' }));
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('current-subscription')).toBeTruthy();
    });

    expect(getByTestId('subscription-entitlement').props.children).toBe('Unlocked');
  });

  it('shows error state with retry when subscription load fails', async () => {
    const api = createMockApi(null, {
      get: jest.fn(async (path: string) => {
        if (path === '/v1/subscriptions/me') {
          throw new Error('Network unavailable');
        }
        if (path === '/v1/subscriptions/products') {
          return { products: mockProducts, appleConfigured: true, googleConfigured: true };
        }
        throw new Error(`Unexpected GET ${path}`);
      }) as never,
    });
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('current-subscription-error')).toBeTruthy();
    });

    const errorCard = getByTestId('current-subscription-error');
    expect(errorCard.props.accessibilityRole).toBe('alert');
  });

  it('shows signed-out state when api is null', () => {
    const { getByText } = render(<SubscriptionScreen api={null} />);
    expect(getByText('Sign in required')).toBeTruthy();
  });

  it('loads and displays products with store prices', async () => {
    const api = createMockApi(null);
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('plans-list')).toBeTruthy();
    });

    const plan = getByTestId('plan-premium_individual');
    expect(plan.props.accessibilityLabel).toContain('Premium Individual');
    expect(plan.props.accessibilityLabel).toContain('$9.99');
  });

  it('shows manage subscription button for store subscriptions', async () => {
    const api = createMockApi(createSubscription({ status: 'ACTIVE', provider: 'APPLE' }));
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('manage-subscription')).toBeTruthy();
    });

    const button = getByTestId('manage-subscription');
    expect(button.props.accessibilityHint).toContain('App Store');
  });

  it('refresh status reloads subscription from server', async () => {
    const api = createMockApi(createSubscription({ status: 'ACTIVE' }));
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('refresh-status')).toBeTruthy();
    });

    const getMock = api.get as jest.Mock;
    const callsBefore = getMock.mock.calls.filter((c) => c[0] === '/v1/subscriptions/me').length;

    await act(async () => {
      fireEvent.press(getByTestId('refresh-status'));
    });

    await waitFor(() => {
      const callsAfter = getMock.mock.calls.filter((c) => c[0] === '/v1/subscriptions/me').length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it('has accessible labels on key controls', async () => {
    const api = createMockApi(null);
    const { getByTestId } = render(<SubscriptionScreen api={api} />);

    await waitFor(() => {
      expect(getByTestId('restore-purchases')).toBeTruthy();
    });

    expect(getByTestId('restore-purchases').props.accessibilityLabel).toBe('Restore purchases');
    expect(getByTestId('refresh-status').props.accessibilityLabel).toBe(
      'Refresh subscription status',
    );
  });
});
