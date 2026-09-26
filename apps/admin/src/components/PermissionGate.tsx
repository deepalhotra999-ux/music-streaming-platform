// Admin V2 — permission-gated rendering.
//
// <RequirePermission perm="users.ban"> renders children only when the
// caller's effective permission set contains the key. <NotPermitted> is the
// friendly state shown when the server denies (403) or the section is out of
// scope for the role. Both are UX-only: the backend re-checks everything.

import type { ReactNode } from 'react';
import { usePermissions } from '../auth/PermissionsContext';
import type { PermissionKey } from '../api/types';
import { apiErrorMessage } from '../api/client';

export function RequirePermission({
  perm,
  anyOf,
  children,
}: {
  /** All listed keys required… */
  perm?: PermissionKey;
  /** …or at least one of these. */
  anyOf?: PermissionKey[];
  children: ReactNode;
}): React.ReactNode {
  const { can, isLoading } = usePermissions();
  if (isLoading) return null;
  const ok = perm ? can(perm) : true;
  const anyOk = anyOf ? anyOf.some((key) => can(key)) : true;
  if (!ok || !anyOk) return null;
  return <>{children}</>;
}

/**
 * SUPER_ADMIN-only section. The backend guards these routes with
 * requireSuperAdmin(); this is the UI hint for them.
 */
export function RequireSuperAdmin({ children }: { children: ReactNode }): React.ReactNode {
  const { isSuperAdmin, isLoading } = usePermissions();
  if (isLoading) return null;
  if (!isSuperAdmin) return <NotPermitted />;
  return <>{children}</>;
}

export function NotPermitted({ error }: { error?: unknown }): React.ReactNode {
  return (
    <div className="card">
      <h2>Not permitted</h2>
      <p className="muted">
        {error
          ? apiErrorMessage(error)
          : 'Your admin role does not include this section. If you need access, ask a SUPER_ADMIN to grant it.'}
      </p>
    </div>
  );
}

/**
 * Wraps a data fetch: on 403 renders <NotPermitted/> instead of the generic
 * error state. Pass the render function for the loaded state.
 */
export function PermissionAwareSection({
  loading,
  error,
  children,
}: {
  loading: boolean;
  error: unknown;
  children: ReactNode;
}): React.ReactNode {
  if (loading) return null;
  if (error && typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: number }).status;
    if (status === 403) return <NotPermitted error={error} />;
  }
  return <>{children}</>;
}
