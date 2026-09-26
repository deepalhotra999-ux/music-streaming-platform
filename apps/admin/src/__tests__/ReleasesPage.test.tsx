// Release tooling — ReleasesPage tests: runs table, deploy flow with
// confirmation, unconfigured (503) setup state, and error retry.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ReleasesPage } from '../pages/ReleasesPage';
import { jsonResponse, problemResponse, renderWithAuth } from './helpers';

const RUNS = {
  data: [
    {
      id: 123456,
      runNumber: 42,
      name: 'CD',
      status: 'completed',
      conclusion: 'success',
      headBranch: 'main',
      event: 'repository_dispatch',
      createdAt: '2026-09-26T12:00:00Z',
      updatedAt: '2026-09-26T12:05:00Z',
      htmlUrl: 'https://github.com/deepalhotra999-ux/music-streaming-platform/actions/runs/123456',
    },
  ],
};

function runsHandler() {
  return async (url: string) => {
    if (url.endsWith('/v1/me')) {
      return jsonResponse({ id: 'admin-1', role: 'ADMIN', displayName: 'Ada' });
    }
    if (url.endsWith('/v1/admin/deploy/runs')) return jsonResponse(RUNS);
    if (url.endsWith('/v1/admin/deploy')) {
      return jsonResponse({ dispatched: true, ref: 'main', eventType: 'deploy-requested' }, 202);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

describe('ReleasesPage', () => {
  it('renders the recent runs table', async () => {
    renderWithAuth(<ReleasesPage />, { fetchHandler: runsHandler() });
    expect(await screen.findByText('#42')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('success')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'View on GitHub' });
    expect(link).toHaveAttribute('href', RUNS.data[0].htmlUrl);
  });

  it('deploys after confirmation and shows the notice', async () => {
    const { fetchMock } = renderWithAuth(<ReleasesPage />, { fetchHandler: runsHandler() });
    await screen.findByText('#42');

    fireEvent.change(screen.getByLabelText('Branch or tag'), { target: { value: 'main' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));

    // Confirm dialog appears; confirming fires the dispatch.
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deploy' }));

    await waitFor(() => {
      expect(screen.getByText(/Deploy requested for "main"/)).toBeInTheDocument();
    });
    const dispatchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/admin/deploy'),
    );
    expect(dispatchCalls).toHaveLength(1);
  });

  it('does not dispatch when the confirmation is cancelled', async () => {
    const { fetchMock } = renderWithAuth(<ReleasesPage />, { fetchHandler: runsHandler() });
    await screen.findByText('#42');

    fireEvent.click(screen.getByRole('button', { name: 'Deploy' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    const dispatchCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/v1/admin/deploy'),
    );
    expect(dispatchCalls).toHaveLength(0);
  });

  it('shows setup instructions when the API is not configured (503)', async () => {
    renderWithAuth(<ReleasesPage />, {
      fetchHandler: async (url: string) => {
        if (url.endsWith('/v1/me')) {
          return jsonResponse({ id: 'admin-1', role: 'ADMIN', displayName: 'Ada' });
        }
        if (url.endsWith('/v1/admin/deploy/runs')) {
          return problemResponse(503, 'Service Unavailable', 'GITHUB_DEPLOY_TOKEN missing');
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });
    expect(await screen.findByText(/fine-grained personal access token/)).toBeInTheDocument();
    expect(screen.getAllByText(/GITHUB_DEPLOY_TOKEN/).length).toBeGreaterThanOrEqual(1);
  });

  it('shows an error with retry when the runs request fails', async () => {
    renderWithAuth(<ReleasesPage />, {
      fetchHandler: async (url: string) => {
        if (url.endsWith('/v1/me')) {
          return jsonResponse({ id: 'admin-1', role: 'ADMIN', displayName: 'Ada' });
        }
        return problemResponse(500, 'Server error', 'boom');
      },
    });
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
