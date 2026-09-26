// Admin V2 — permission-gated nav, impersonation banner, emergency confirmation.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AdminLayout } from '../components/Layout';
import { ImpersonationBanner, ACCESS_TOKEN_KEY } from '../components/ImpersonationBanner';
import { PlatformConfigPage } from '../pages/PlatformConfigPage';
import { adminUser, jsonResponse, renderWithAuth } from './helpers';
import type { PermissionKey } from '../api/types';

function base64UrlEncode(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function impersonationToken(): string {
  const header = base64UrlEncode({ alg: 'HS256', typ: 'JWT' });
  const payload = base64UrlEncode({
    imp: true,
    actorId: 'admin-0001',
    reason: 'support ticket #123',
    impStartedAt: new Date().toISOString(),
    sub: 'user-999',
    email: 'customer@example.com',
    role: 'LISTENER',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  return `${header}.${payload}.fakesignature`;
}

describe('permission-gated nav', () => {
  it('shows only sections the caller may use', async () => {
    renderWithAuth(<AdminLayout />, {
      permissions: ['users.view', 'audit.view'] as PermissionKey[],
    });
    // Wait for the permission-gated items to settle.
    await screen.findByRole('link', { name: 'Users' });
    expect(screen.getByRole('link', { name: 'Audit Log' })).toBeInTheDocument();
    // Always-visible sections.
    expect(screen.getByRole('link', { name: 'Command Center' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Search' })).toBeInTheDocument();
    // Gated sections the caller lacks.
    expect(screen.queryByRole('link', { name: 'Finance' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Security' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Roles' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Platform Config' })).not.toBeInTheDocument();
  });

  it('shows everything for a fully permissioned caller', async () => {
    renderWithAuth(<AdminLayout />);
    await screen.findByRole('link', { name: 'Users' });
    for (const label of [
      'Command Center',
      'Search',
      'Users',
      'Finance',
      'Security',
      'Audit Log',
      'Roles',
      'Platform Config',
    ]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });
});

describe('impersonation banner', () => {
  it('renders the warning with reason and countdown when an impersonation token is stored', async () => {
    const { fetchMock } = renderWithAuth(<ImpersonationBanner />);
    // renderWithAuth seeds a normal token; swap in the impersonation token
    // afterwards — the banner re-checks storage every second.
    localStorage.setItem(ACCESS_TOKEN_KEY, impersonationToken());
    const alert = await screen.findByRole('alert', undefined, { timeout: 3000 });
    expect(alert).toHaveTextContent('IMPERSONATING');
    expect(alert).toHaveTextContent('customer@example.com');
    expect(alert).toHaveTextContent('support ticket #123');
    expect(alert).toHaveTextContent(/expires in \d\d:\d\d/);
    expect(screen.getByRole('button', { name: 'End impersonation' })).toBeInTheDocument();
    expect(fetchMock).toBeDefined();
    localStorage.removeItem(ACCESS_TOKEN_KEY);
  });

  it('renders nothing for a normal admin token', () => {
    const { container } = renderWithAuth(<ImpersonationBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ends the session via the API and signs out', async () => {
    const { fetchMock } = renderWithAuth(<ImpersonationBanner />);
    localStorage.setItem(ACCESS_TOKEN_KEY, impersonationToken());
    fireEvent.click(
      await screen.findByRole('button', { name: 'End impersonation' }, { timeout: 3000 }),
    );
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(calls.some((url) => url.endsWith('/v1/admin/impersonation/end'))).toBe(true);
    });
    localStorage.removeItem(ACCESS_TOKEN_KEY);
  });
});

describe('emergency controls confirmation', () => {
  const settings = [
    {
      key: 'emergency.maintenance_mode',
      value: false,
      updatedAt: '2026-01-01T00:00:00Z',
      updatedBy: null,
    },
    {
      key: 'platform.maintenance_message',
      value: 'Down for maintenance',
      updatedAt: '2026-01-01T00:00:00Z',
      updatedBy: null,
    },
  ];

  it('requires explicit confirmation before applying a break-glass change', async () => {
    const putCalls: string[] = [];
    const superAdmin = { ...adminUser(), role: 'SUPER_ADMIN' as const };
    renderWithAuth(<PlatformConfigPage />, {
      user: superAdmin,
      fetchHandler: (url, init) => {
        if (url.endsWith('/v1/admin/flags')) return jsonResponse([]);
        if (url.endsWith('/v1/admin/settings')) return jsonResponse(settings);
        if (url.endsWith('/v1/me')) return jsonResponse(superAdmin);
        if (url.includes('/v1/admin/settings/') && init?.method === 'PUT') {
          putCalls.push(url);
          return jsonResponse({ ok: true });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method}`);
      },
    });

    // The emergency section lists the break-glass control.
    const applyButtons = await screen.findAllByRole('button', { name: 'Apply' });
    expect(applyButtons.length).toBeGreaterThan(0);
    fireEvent.click(applyButtons[0]);

    // A destructive confirmation appears; nothing has been sent yet.
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/break-glass/i);
    expect(putCalls).toHaveLength(0);

    // Cancelling aborts the change.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(putCalls).toHaveLength(0);
  });

  it('sends the change only after the break-glass confirmation is accepted', async () => {
    const putCalls: { url: string; body: unknown }[] = [];
    const superAdmin = { ...adminUser(), role: 'SUPER_ADMIN' as const };
    renderWithAuth(<PlatformConfigPage />, {
      user: superAdmin,
      fetchHandler: (url, init) => {
        if (url.endsWith('/v1/admin/flags')) return jsonResponse([]);
        if (url.endsWith('/v1/admin/settings')) return jsonResponse(settings);
        if (url.endsWith('/v1/me')) return jsonResponse(superAdmin);
        if (url.includes('/v1/admin/settings/') && init?.method === 'PUT') {
          putCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
          return jsonResponse({ ok: true });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method}`);
      },
    });

    const applyButtons = await screen.findAllByRole('button', { name: 'Apply' });
    fireEvent.click(applyButtons[0]);
    const dialog = await screen.findByRole('alertdialog');
    // The confirm button names the exact key being changed.
    const confirmButton = screen.getByRole('button', { name: /Set emergency\./ });
    expect(dialog).toContainElement(confirmButton);
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(putCalls).toHaveLength(1);
    });
    expect(putCalls[0].url).toContain('/v1/admin/settings/emergency.maintenance_mode');
  });
});
