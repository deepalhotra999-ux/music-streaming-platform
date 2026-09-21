// Phase 16 — RequireAdmin guard tests:
// - ADMIN passes through to the protected content.
// - LISTENER and ARTIST see an explicit access-denied screen (not a silent
//   bounce) with a working logout button.
// - Unauthenticated visitors are redirected to /login.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { RequireAdmin } from '../auth/AuthContext';
import { LoginPage } from '../pages/LoginPage';
import { adminUser, jsonResponse, renderAnonymous, renderWithAuth } from './helpers';

function GuardedRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="*"
        element={
          <RequireAdmin>
            <div data-testid="protected-content">Secret admin stuff</div>
          </RequireAdmin>
        }
      />
    </Routes>
  );
}

describe('RequireAdmin', () => {
  it('renders protected content for ADMIN users', async () => {
    renderWithAuth(<GuardedRoutes />, { user: adminUser({ role: 'ADMIN' }) });

    expect(await screen.findByTestId('protected-content')).toHaveTextContent('Secret admin stuff');
  });

  it.each(['LISTENER', 'ARTIST'] as const)(
    'shows an access-denied screen for %s users',
    async (role) => {
      const fetchMock = renderWithAuth(<GuardedRoutes />, {
        user: adminUser({ role, displayName: 'Regular User' }),
        fetchHandler: (url) => {
          if (url.endsWith('/v1/me')) return jsonResponse(adminUser({ role }));
          if (url.endsWith('/v1/auth/logout')) return jsonResponse({}, 200);
          throw new Error(`unexpected fetch: ${url}`);
        },
      }).fetchMock;

      const denied = await screen.findByText('Access denied — admin only');
      expect(denied).toBeInTheDocument();
      expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();

      // Logout returns the user to the login screen and revokes server-side.
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
      const logoutCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/auth/logout'),
      );
      expect(logoutCalls).toHaveLength(1);
      expect(localStorage.getItem('waveform.admin.accessToken')).toBeNull();
    },
  );

  it('redirects unauthenticated visitors to /login', async () => {
    renderAnonymous(<GuardedRoutes />);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });
});
