// Admin V2 — audit reversal and role management UI tests.
//
// Reversal is SUPER_ADMIN-only, append-only, and requires an explicit
// confirmation. Role changes require confirmation and are blocked for the
// caller's own account.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { AuditLogPage } from '../pages/AuditLogPage';
import { RolesPage } from '../pages/RolesPage';
import { adminUser, jsonResponse, renderWithAuth } from './helpers';
import type { AdminUser, PermissionKey } from '../api/types';

const superAdmin = { ...adminUser(), role: 'SUPER_ADMIN' as const };

function auditRows() {
  return [
    {
      id: 'evt-1',
      actorId: 'admin-0001',
      action: 'user.ban',
      targetType: 'user',
      targetId: 'user-9',
      metadata: { reason: 'spam' },
      createdAt: '2026-09-26T10:00:00.000Z',
      reversible: true,
      reversedBy: null,
      reversalOf: null,
    },
    {
      id: 'evt-2',
      actorId: 'admin-0001',
      action: 'user.role.changed',
      targetType: 'user',
      targetId: 'user-8',
      metadata: null,
      createdAt: '2026-09-26T09:00:00.000Z',
      reversible: false,
      reversedBy: null,
      reversalOf: null,
    },
  ];
}

function renderAudit(permissions?: PermissionKey[]) {
  return renderWithAuth(<AuditLogPage />, {
    user: superAdmin,
    permissions,
    fetchHandler: (url, init) => {
      if (url.endsWith('/v1/me')) return jsonResponse(superAdmin);
      if (url.includes('/v1/admin/audit-logs') && !url.includes('/reverse')) {
        return jsonResponse({ data: auditRows(), pagination: null });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method}`);
    },
  });
}

describe('audit reversal', () => {
  it('offers Reverse only to SUPER_ADMIN on reversible, unreversed rows', async () => {
    renderAudit();
    await screen.findByText('user.ban');
    const reverseButtons = screen.getAllByRole('button', { name: 'Reverse…' });
    expect(reverseButtons).toHaveLength(1);
  });

  it('hides the Reverse control from non-SUPER_ADMIN callers', async () => {
    const support = { ...adminUser(), role: 'SUPPORT_ADMIN' as const };
    renderWithAuth(<AuditLogPage />, {
      user: support,
      permissions: ['audit.view'],
      fetchHandler: (url, init) => {
        if (url.endsWith('/v1/me')) return jsonResponse(support);
        if (url.includes('/v1/admin/audit-logs')) {
          return jsonResponse({ data: auditRows(), pagination: null });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method}`);
      },
    });
    await screen.findByText('user.ban');
    expect(screen.queryByRole('button', { name: 'Reverse…' })).not.toBeInTheDocument();
  });

  it('confirms before posting the reversal', async () => {
    const reverseCalls: string[] = [];
    const { fetchMock } = renderWithAuth(<AuditLogPage />, {
      user: superAdmin,
      fetchHandler: (url, init) => {
        if (url.endsWith('/v1/me')) return jsonResponse(superAdmin);
        if (url.endsWith('/v1/admin/audit-logs/evt-1/reverse') && init?.method === 'POST') {
          reverseCalls.push(url);
          return jsonResponse({ reversed: true });
        }
        if (url.includes('/v1/admin/audit-logs')) {
          return jsonResponse({ data: auditRows(), pagination: null });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method}`);
      },
    });
    await screen.findByText('user.ban');
    fireEvent.click(screen.getByRole('button', { name: 'Reverse…' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/user\.ban/);
    expect(reverseCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Reverse action' }));
    await waitFor(() => expect(reverseCalls).toHaveLength(1));
    expect(fetchMock).toBeDefined();
  });
});

describe('role management', () => {
  const accounts = [
    {
      id: 'admin-0001',
      email: 'super@example.com',
      displayName: 'Root',
      role: 'SUPER_ADMIN',
      bundlePermissions: [],
      grantedPermissions: [],
      effectivePermissions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'admin-0002',
      email: 'mod@example.com',
      displayName: 'Mo Mod',
      role: 'MODERATOR',
      bundlePermissions: ['users.view'],
      grantedPermissions: [],
      effectivePermissions: ['users.view'],
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  ];
  const catalog = {
    roles: [{ role: 'MODERATOR', bundlePermissions: ['users.view'] }],
    permissions: [{ key: 'users.view', description: 'View users' }],
    assignableRoles: ['MODERATOR', 'SUPPORT_ADMIN', 'SUPER_ADMIN'],
  };

  function renderRoles(
    user: AdminUser = superAdmin,
    extra?: (url: string, init?: RequestInit) => never,
  ) {
    return renderWithAuth(<RolesPage />, {
      user,
      fetchHandler: (url, init) => {
        if (url.endsWith('/v1/me')) return jsonResponse(user);
        if (url.endsWith('/v1/admin/admins')) return jsonResponse(accounts);
        if (url.endsWith('/v1/admin/roles')) return jsonResponse(catalog);
        if (extra) return extra(url, init);
        throw new Error(`unexpected fetch: ${url} ${init?.method}`);
      },
    });
  }

  it('blocks non-SUPER_ADMIN callers', async () => {
    const support = { ...adminUser(), role: 'SUPPORT_ADMIN' as const };
    renderRoles(support);
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.queryByText(/Admin accounts/)).not.toBeInTheDocument();
  });

  it('blocks self role changes', async () => {
    renderRoles();
    await screen.findByText('Admin accounts (2)');
    const selfSelect = screen.getByRole('combobox', { name: 'New role for Root' });
    expect(selfSelect).toBeDisabled();
    expect(screen.getByText(/self-changes are blocked/)).toBeInTheDocument();
  });

  it('confirms before assigning a role', async () => {
    const patchCalls: { url: string; body: unknown }[] = [];
    renderWithAuth(<RolesPage />, {
      user: superAdmin,
      fetchHandler: (url, init) => {
        if (url.endsWith('/v1/me')) return jsonResponse(superAdmin);
        if (url.endsWith('/v1/admin/admins')) return jsonResponse(accounts);
        if (url.endsWith('/v1/admin/roles')) return jsonResponse(catalog);
        if (url.endsWith('/v1/users/admin-0002/role') && init?.method === 'PATCH') {
          patchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
          return jsonResponse({ ...accounts[1], role: 'SUPPORT_ADMIN' });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method}`);
      },
    });
    await screen.findByText('Admin accounts (2)');

    const select = screen.getByRole('combobox', { name: 'New role for Mo Mod' });
    fireEvent.change(select, { target: { value: 'SUPPORT_ADMIN' } });
    const applyButtons = screen.getAllByRole('button', { name: 'Apply' });
    fireEvent.click(applyButtons[1]);

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/SUPPORT_ADMIN/);
    expect(patchCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Change to SUPPORT_ADMIN' }));
    await waitFor(() => expect(patchCalls).toHaveLength(1));
    expect(patchCalls[0].body).toEqual({ role: 'SUPPORT_ADMIN' });
  });
});
