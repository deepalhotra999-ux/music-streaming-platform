// Admin V2 — caller's effective permissions.
//
// Fetched from GET /v1/admin/me/permissions once the admin is signed in.
// This is a UI HINT ONLY: it hides nav sections and action buttons the
// caller cannot use, but every endpoint re-checks server-side. A missing
// permission here never grants anything, and a stale set never blocks the
// server from denying.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { getMyPermissions } from '../api/ops';
import type { AdminUserRole, PermissionKey } from '../api/types';

export interface PermissionsState {
  role: AdminUserRole | null;
  permissions: Set<PermissionKey>;
  isSuperAdmin: boolean;
  isLoading: boolean;
  /** True when the caller's effective set contains every key. */
  can: (...keys: PermissionKey[]) => boolean;
  reload: () => void;
}

const PermissionsContext = createContext<PermissionsState | null>(null);

export function PermissionsProvider({ children }: { children: ReactNode }): ReactNode {
  const { client, user } = useAuth();
  const [role, setRole] = useState<AdminUserRole | null>(null);
  const [permissions, setPermissions] = useState<Set<PermissionKey>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!user) {
      setRole(null);
      setPermissions(new Set());
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    getMyPermissions(client)
      .then((result) => {
        if (cancelled) return;
        const role = result.role as AdminUserRole;
        setRole(role);
        // The backend's permission registry has no keys for the
        // SUPER_ADMIN-only controls (role management, flags, settings,
        // impersonation, audit reversal): those routes check
        // `role === 'SUPER_ADMIN'` directly instead of a permission key.
        // Augment the UI hint set so <RequirePermission> and the nav can
        // gate those sections. UI hint only — the server re-checks.
        const keys = new Set(result.permissions as PermissionKey[]);
        if (role === 'SUPER_ADMIN') {
          keys.add('roles.manage');
          keys.add('flags.manage');
          keys.add('settings.manage');
          keys.add('users.impersonate');
          keys.add('audit.reverse');
        }
        setPermissions(keys);
      })
      .catch(() => {
        // Fail closed in the UI: on error the shell shows only the
        // universally safe sections until a reload succeeds.
        if (!cancelled) {
          setRole(user.role);
          setPermissions(new Set());
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, user, reloadToken]);

  const can = useCallback(
    (...keys: PermissionKey[]) => keys.every((key) => permissions.has(key)),
    [permissions],
  );

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const value: PermissionsState = {
    role,
    permissions,
    isSuperAdmin: role === 'SUPER_ADMIN',
    isLoading,
    can,
    reload,
  };

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions(): PermissionsState {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermissions must be used inside <PermissionsProvider>');
  return ctx;
}
