// Phase 18 — subscription inspection in the admin user detail: status
// badge, plan, provider, period, entitlement, and event history render
// from the read-only inspection endpoint.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { UsersPage } from '../pages/UsersPage';
import { adminUser, jsonResponse, pageEnvelope, renderWithAuth } from './helpers';
import type { AdminSubscriptionDetail, AdminUser } from '../api/types';

function makeUser(): AdminUser {
  return adminUser({
    id: 'user-1',
    email: 'listener@example.com',
    displayName: 'Leo Listener',
    role: 'LISTENER',
  });
}

function subscriptionDetail(): AdminSubscriptionDetail {
  return {
    subscription: {
      id: 'sub-1',
      userId: 'user-1',
      planId: 'premium_family',
      plan: { id: 'premium_family', name: 'Premium Family', planType: 'FAMILY', active: true },
      provider: 'APPLE',
      status: 'PAST_DUE',
      storeProductId: 'com.waveform.test.premium.family',
      currentPeriodStart: '2026-09-01T00:00:00.000Z',
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      canceledAt: null,
      verificationStatus: 'VERIFIED',
      lastVerifiedAt: '2026-09-20T12:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    entitlement: {
      entitled: true,
      status: 'PAST_DUE',
      planCode: 'premium_family',
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      reason: 'ok',
    },
    events: [
      {
        id: 'evt-1',
        eventType: 'SUBSCRIPTION_STARTED',
        statusFrom: null,
        statusTo: 'ACTIVE',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'evt-2',
        eventType: 'PAYMENT_FAILED',
        statusFrom: 'ACTIVE',
        statusTo: 'PAST_DUE',
        createdAt: '2026-09-20T00:00:00.000Z',
      },
    ],
    latestEvent: {
      id: 'evt-2',
      eventType: 'PAYMENT_FAILED',
      statusFrom: 'ACTIVE',
      statusTo: 'PAST_DUE',
      createdAt: '2026-09-20T00:00:00.000Z',
    },
  };
}

function renderWithSubscription(sub: AdminSubscriptionDetail | null) {
  return renderWithAuth(<UsersPage />, {
    user: adminUser(),
    fetchHandler: (url) => {
      if (url.endsWith('/v1/me')) return jsonResponse(adminUser());
      const u = new URL(url);
      if (u.pathname === '/v1/users') {
        return jsonResponse(pageEnvelope([makeUser()], 1, 20, 1));
      }
      if (u.pathname === '/v1/admin/users/user-1') {
        return jsonResponse({
          ...makeUser(),
          updatedAt: '2026-09-01T00:00:00.000Z',
          ownedArtists: [],
        });
      }
      if (u.pathname === '/v1/admin/users/user-1/subscription') {
        return jsonResponse(sub);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
}

async function openDetail() {
  renderWithSubscription(subscriptionDetail());
  expect(await screen.findByText('Leo Listener')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'View' }));
  expect(await screen.findByText('Subscription')).toBeInTheDocument();
}

describe('admin subscription inspection', () => {
  it('renders status badge, plan, provider, period, and entitlement', async () => {
    await openDetail();
    expect(screen.getByText('PAST DUE')).toBeInTheDocument();
    expect(screen.getByText('Premium Family')).toBeInTheDocument();
    expect(screen.getByText('APPLE')).toBeInTheDocument();
    expect(screen.getByText('Entitled')).toBeInTheDocument();
  });

  it('renders Phase 19 store fields: product id, verification, latest event', async () => {
    await openDetail();
    // Store product id resolved from the plan mapping.
    expect(screen.getByText('com.waveform.test.premium.family')).toBeInTheDocument();
    // Verification badge.
    expect(screen.getByText('Verified')).toBeInTheDocument();
    // Latest event at a glance (appears in the detail grid and the history table).
    expect(screen.getAllByText(/PAYMENT_FAILED/).length).toBeGreaterThan(0);
  });

  it('renders the append-only event history', async () => {
    await openDetail();
    expect(screen.getByText('Event history (2)')).toBeInTheDocument();
    expect(screen.getByText('SUBSCRIPTION_STARTED')).toBeInTheDocument();
    expect(screen.getByText('PAYMENT_FAILED')).toBeInTheDocument();
  });

  it('renders the empty state when the user has no subscription', async () => {
    renderWithSubscription({
      subscription: null,
      entitlement: {
        entitled: false,
        status: 'NONE',
        planCode: null,
        currentPeriodEnd: null,
        reason: 'no_subscription',
      },
      events: [],
      latestEvent: null,
    });
    expect(await screen.findByText('Leo Listener')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText('Subscription')).toBeInTheDocument();
    expect(await screen.findByText('No subscription on file.')).toBeInTheDocument();
  });
});
