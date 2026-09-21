// Phase 18 — SubscriptionCard: loading, error, no-subscription, active,
// and locked states render the right content and testIDs.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { SubscriptionCard } from '../SubscriptionCard';
import type { MySubscription } from '../../api';

const activeData: MySubscription = {
  subscription: {
    id: 'sub-1',
    planId: 'premium_individual',
    plan: {
      id: 'premium_individual',
      name: 'Premium Individual',
      planType: 'INDIVIDUAL',
      active: true,
    },
    provider: 'APPLE',
    status: 'ACTIVE',
    currentPeriodStart: '2026-09-01T00:00:00.000Z',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    canceledAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  },
  entitlement: {
    entitled: true,
    status: 'ACTIVE',
    planCode: 'premium_individual',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    reason: 'ok',
  },
};

const baseProps = {
  data: null as MySubscription | null,
  loading: false,
  error: null as string | null,
  onRetry: jest.fn(),
};

describe('SubscriptionCard', () => {
  it('renders loading state', () => {
    render(<SubscriptionCard {...baseProps} loading />);
    expect(screen.getByTestId('subscription-card-loading')).toBeTruthy();
  });

  it('renders error state with retry', () => {
    const onRetry = jest.fn();
    render(<SubscriptionCard {...baseProps} error="Network down" onRetry={onRetry} />);
    expect(screen.getByTestId('subscription-card-error')).toBeTruthy();
    fireEvent.press(screen.getByTestId('subscription-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders free plan when there is no subscription', () => {
    render(
      <SubscriptionCard
        {...baseProps}
        data={{
          subscription: null,
          entitlement: {
            entitled: false,
            status: 'NONE',
            planCode: null,
            currentPeriodEnd: null,
            reason: 'no_subscription',
          },
        }}
      />,
    );
    expect(screen.getByTestId('subscription-card-none')).toBeTruthy();
    expect(screen.getByText('Free plan')).toBeTruthy();
  });

  it('renders active subscription with plan name, status, and unlocked playback', () => {
    render(<SubscriptionCard {...baseProps} data={activeData} />);
    expect(screen.getByTestId('subscription-card')).toBeTruthy();
    expect(screen.getByText('Premium Individual')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByTestId('subscription-entitlement')).toHaveTextContent('Unlocked');
  });

  it('renders locked playback for a non-entitled subscription', () => {
    const locked: MySubscription = {
      subscription: { ...activeData.subscription!, status: 'EXPIRED' },
      entitlement: {
        ...activeData.entitlement,
        entitled: false,
        status: 'EXPIRED',
        reason: 'subscription_expired',
      },
    };
    render(<SubscriptionCard {...baseProps} data={locked} />);
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByTestId('subscription-entitlement')).toHaveTextContent('Locked');
  });

  it('labels the billing provider', () => {
    const google: MySubscription = {
      ...activeData,
      subscription: { ...activeData.subscription!, provider: 'GOOGLE' },
    };
    render(<SubscriptionCard {...baseProps} data={google} />);
    expect(screen.getByText('Google Play')).toBeTruthy();
  });
});
