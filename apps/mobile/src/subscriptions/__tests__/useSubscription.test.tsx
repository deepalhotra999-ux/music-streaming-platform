// Phase 18 — useSubscription hook: idle → loading → ready/error state
// machine and retry.

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { getMySubscription } from '../../api';
import { useSubscription } from '../useSubscription';
import type { MySubscription } from '../../api';

jest.mock('../../api', () => ({
  getMySubscription: jest.fn(),
  apiErrorMessage: jest.requireActual('../../api').apiErrorMessage,
}));

const mockGetMySubscription = getMySubscription as jest.Mock;

const entitledData: MySubscription = {
  subscription: {
    id: 'sub-1',
    planId: 'premium_individual',
    plan: {
      id: 'premium_individual',
      name: 'Premium Individual',
      planType: 'INDIVIDUAL',
      active: true,
    },
    provider: 'DEV',
    status: 'ACTIVE',
    currentPeriodStart: null,
    currentPeriodEnd: null,
    canceledAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  entitlement: {
    entitled: true,
    status: 'ACTIVE',
    planCode: 'premium_individual',
    currentPeriodEnd: null,
    reason: 'ok',
  },
};

const client = {} as never;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useSubscription', () => {
  it('loads and reaches ready with server data', async () => {
    mockGetMySubscription.mockResolvedValue(entitledData);
    const { result } = renderHook(() => useSubscription(client));

    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.data).toBe(entitledData);
    expect(result.current.error).toBeNull();
  });

  it('reaches error and retries', async () => {
    mockGetMySubscription.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useSubscription(client));

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.error).toBe('boom');

    mockGetMySubscription.mockResolvedValue(entitledData);
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.data).toBe(entitledData);
  });

  it('stays idle without a client', () => {
    const { result } = renderHook(() => useSubscription(null));
    expect(result.current.state).toBe('idle');
    expect(result.current.data).toBeNull();
  });
});
