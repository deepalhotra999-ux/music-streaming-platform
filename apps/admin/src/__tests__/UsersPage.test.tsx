// Phase 16 — Users page tests: search wiring and pagination wiring.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { UsersPage } from '../pages/UsersPage';
import { adminUser, jsonResponse, pageEnvelope, renderWithAuth } from './helpers';
import type { AdminUser } from '../api/types';

function makeUser(index: number, q: string | null): AdminUser {
  return adminUser({
    id: `user-${q ?? 'all'}-${index}`,
    email: `user${index}@example.com`,
    displayName: q ? `Result ${q} ${index}` : `User ${index}`,
    role: 'LISTENER',
  });
}

describe('UsersPage', () => {
  function renderUsers() {
    return renderWithAuth(<UsersPage />, {
      user: adminUser(),
      fetchHandler: (url) => {
        if (url.endsWith('/v1/me')) return jsonResponse(adminUser());
        const u = new URL(url);
        if (u.pathname === '/v1/users') {
          const q = u.searchParams.get('q');
          const page = Number(u.searchParams.get('page') ?? '1');
          const limit = Number(u.searchParams.get('limit') ?? '20');
          const data = [makeUser(1, q), makeUser(2, q)];
          return jsonResponse(pageEnvelope(data, page, limit, 45));
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });
  }

  it('wires the search box to the q parameter', async () => {
    const { fetchMock } = renderUsers();

    expect(await screen.findByText('User 1')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Name or email…'), {
      target: { value: 'alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Result alice 1')).toBeInTheDocument();

    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/users?'));
    const lastCall = searchCalls[searchCalls.length - 1];
    if (!lastCall) throw new Error('expected a search request');
    expect(String(lastCall[0])).toContain('q=alice');
  });

  it('wires pagination to the page parameter', async () => {
    const { fetchMock } = renderUsers();

    expect(await screen.findByText('User 1')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    });
    const pageCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/users?'));
    const lastCall = pageCalls[pageCalls.length - 1];
    if (!lastCall) throw new Error('expected a page request');
    expect(String(lastCall[0])).toContain('page=2');
  });
});
