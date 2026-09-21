// Phase 16 — Dashboard tests: loading state, then error states with
// working retry on failure.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { DashboardPage } from '../pages/DashboardPage';
import { adminUser, problemResponse, renderWithAuth } from './helpers';

describe('DashboardPage', () => {
  it('shows loading, then error states with retry when the API fails', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { fetchMock } = renderWithAuth(<DashboardPage />, {
      user: adminUser(),
      fetchHandler: async (url) => {
        if (url.endsWith('/v1/me')) {
          return new Response(JSON.stringify(adminUser()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        await gate;
        return problemResponse(500, 'Server error', 'database is down');
      },
    });

    // Loading state is visible while the parallel requests are in flight.
    expect(await screen.findByText('Loading totals…')).toBeInTheDocument();

    // Release the gate: requests now fail, and both sections show errors.
    releaseGate();

    // Both the totals and the overview sections surface errors with retry.
    const retries = await screen.findAllByRole('button', { name: 'Retry' });
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('database is down').length).toBeGreaterThanOrEqual(1);

    const callsBefore = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/v1/users?'),
    ).length;
    const [firstRetry] = retries;
    if (!firstRetry) throw new Error('expected a retry button');
    fireEvent.click(firstRetry);
    await waitFor(() => {
      const callsAfter = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/v1/users?'),
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it('renders server totals and overview numbers verbatim', async () => {
    renderWithAuth(<DashboardPage />, {
      user: adminUser(),
      fetchHandler: (url, init) => {
        if (url.endsWith('/v1/me')) {
          return new Response(JSON.stringify(adminUser()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/v1/analytics/platform/overview')) {
          return new Response(
            JSON.stringify({
              artistId: null,
              range: '7d',
              from: null,
              to: '2026-09-21T00:00:00.000Z',
              streams: 1234,
              starts: 2000,
              failedPlays: 10,
              incompletePlays: 20,
              uniqueListeners: 500,
              listeningTimeMs: 3_600_000,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        const u = new URL(url);
        const status = u.searchParams.get('status');
        const total = status === 'READY' ? 42 : status === 'PROCESSING' ? 3 : 0;
        void init;
        return new Response(
          JSON.stringify({
            data: [],
            pagination: { page: 1, limit: 1, total, totalPages: Math.max(1, total) },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    // Totals come from the limit=1 pagination envelopes…
    expect(await screen.findByText('42')).toBeInTheDocument();
    // …and the overview numbers are displayed verbatim.
    expect(await screen.findByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('2,000')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
  });
});
