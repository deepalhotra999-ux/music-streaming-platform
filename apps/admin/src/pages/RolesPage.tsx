// Admin V2 — role management (SUPER_ADMIN only).
//
// - Lists every admin account with its bundle, additive grants, and
//   effective permissions.
// - Assigns roles (PATCH /v1/users/:id/role). Self-changes are blocked in
//   the UI (the server blocks them too); demoting the last SUPER_ADMIN is
//   refused server-side.
// - Replaces additive per-account grants (PUT .../grants).
// - Shows the role catalog: every role, its bundle, and every permission key.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/PermissionsContext';
import { apiErrorMessage } from '../api/client';
import { getRoleCatalog, listAdminAccounts, setUserGrants, setUserRole } from '../api/governance';
import type { AdminAccount, AssignableRole, PermissionKey, RoleCatalog } from '../api/types';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { useConfirm } from '../components/ConfirmDialog';
import { NotPermitted, RequireSuperAdmin } from '../components/PermissionGate';
import { RoleBadge } from '../components/Badges';
import { formatDate } from '../utils/format';

export function RolesPage(): React.ReactNode {
  return (
    <RequireSuperAdmin>
      <RolesContent />
    </RequireSuperAdmin>
  );
}

function RolesContent(): React.ReactNode {
  const { client, user: currentAdmin } = useAuth();
  const { reload: reloadPermissions } = usePermissions();
  const { confirm, dialog } = useConfirm();
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({});
  const [grantDrafts, setGrantDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accts, cat] = await Promise.all([listAdminAccounts(client), getRoleCatalog(client)]);
      setAccounts(accts);
      setCatalog(cat);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAssignRole(account: AdminAccount): Promise<void> {
    const next = roleDrafts[account.id] ?? account.role;
    if (next === account.role) return;
    setActionError(null);
    setActionOk(null);
    if (account.id === currentAdmin?.id) {
      setActionError('You cannot change your own role.');
      return;
    }
    const confirmed = await confirm({
      title: `Change ${account.displayName}'s role?`,
      message: `${account.email} will move from ${account.role} to ${next}. Effective permissions change immediately. This is recorded in the audit log.`,
      confirmLabel: `Change to ${next}`,
    });
    if (!confirmed) return;
    setBusyId(account.id);
    try {
      await setUserRole(client, account.id, next as AssignableRole);
      setActionOk(`Role updated to ${next}.`);
      await load();
      reloadPermissions();
    } catch (err) {
      setActionError(apiErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReplaceGrants(account: AdminAccount): Promise<void> {
    const raw = grantDrafts[account.id] ?? account.grantedPermissions.join(', ');
    const permissions = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as PermissionKey[];
    setActionError(null);
    setActionOk(null);
    if (account.id === currentAdmin?.id) {
      setActionError('You cannot edit your own grants.');
      return;
    }
    const confirmed = await confirm({
      title: `Replace grants for ${account.displayName}?`,
      message: `Additive grants will be replaced with: ${permissions.join(', ') || '(none)'}. The role bundle is unchanged. This is recorded in the audit log.`,
      confirmLabel: 'Replace grants',
    });
    if (!confirmed) return;
    setBusyId(account.id);
    try {
      await setUserGrants(client, account.id, permissions);
      setActionOk('Grants replaced.');
      await load();
      reloadPermissions();
    } catch (err) {
      setActionError(apiErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <LoadingState label="Loading admin accounts…" />;
  if (error) {
    const status =
      typeof error === 'object' && error !== null && 'status' in error
        ? (error as { status?: number }).status
        : undefined;
    if (status === 403) return <NotPermitted error={error} />;
    return <ErrorState error={error} onRetry={() => void load()} />;
  }

  return (
    <div>
      <div className="page-header">
        <h1>Roles</h1>
      </div>
      {actionError && (
        <div className="error-banner" role="alert">
          {actionError}
        </div>
      )}
      {actionOk && (
        <div className="success-banner" role="status">
          {actionOk}
        </div>
      )}

      <section aria-label="Admin accounts">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Admin accounts ({accounts?.length ?? 0})
        </h2>
        {!accounts || accounts.length === 0 ? (
          <EmptyState message="No admin accounts." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Role</th>
                  <th scope="col">Effective permissions</th>
                  <th scope="col">Created</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const isSelf = account.id === currentAdmin?.id;
                  return (
                    <tr key={account.id}>
                      <td>
                        {account.displayName}
                        <br />
                        <span className="mono muted">{account.email}</span>
                      </td>
                      <td>
                        <RoleBadge role={account.role} />
                      </td>
                      <td style={{ maxWidth: 320 }}>
                        <span className="mono" style={{ fontSize: 12 }}>
                          {account.effectivePermissions.join(', ') || '—'}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatDate(account.createdAt)}</td>
                      <td>
                        <div className="row-actions">
                          <select
                            aria-label={`New role for ${account.displayName}`}
                            value={roleDrafts[account.id] ?? account.role}
                            disabled={isSelf || busyId === account.id}
                            onChange={(event) =>
                              setRoleDrafts((d) => ({ ...d, [account.id]: event.target.value }))
                            }
                          >
                            {(catalog?.assignableRoles ?? [account.role]).map((role) => (
                              <option key={role} value={role}>
                                {role}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={
                              isSelf ||
                              busyId === account.id ||
                              (roleDrafts[account.id] ?? account.role) === account.role
                            }
                            onClick={() => void handleAssignRole(account)}
                          >
                            Apply
                          </button>
                        </div>
                        <div className="row-actions" style={{ marginTop: 6 }}>
                          <input
                            type="text"
                            aria-label={`Grants for ${account.displayName}`}
                            placeholder="grants, comma-separated"
                            defaultValue={account.grantedPermissions.join(', ')}
                            disabled={isSelf || busyId === account.id}
                            onChange={(event) =>
                              setGrantDrafts((d) => ({ ...d, [account.id]: event.target.value }))
                            }
                            style={{ minWidth: 220 }}
                          />
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={isSelf || busyId === account.id}
                            onClick={() => void handleReplaceGrants(account)}
                          >
                            Replace grants
                          </button>
                        </div>
                        {isSelf && (
                          <p className="muted" style={{ fontSize: 12 }}>
                            This is you — self-changes are blocked.
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Role catalog">
        <h2 className="muted" style={{ fontSize: 14 }}>
          Role catalog
        </h2>
        {!catalog ? (
          <EmptyState message="No catalog data." />
        ) : (
          <>
            {catalog.roles.map((entry) => (
              <div className="card" key={entry.role}>
                <h2>
                  <RoleBadge role={entry.role} />
                </h2>
                <p className="mono" style={{ fontSize: 13 }}>
                  {entry.bundlePermissions.join(', ') || '—'}
                </p>
              </div>
            ))}
            <div className="card">
              <h2>Permission keys</h2>
              <dl className="kv-list">
                {catalog.permissions.map((perm) => (
                  <div key={perm.key} style={{ display: 'contents' }}>
                    <dt className="mono">{perm.key}</dt>
                    <dd>{perm.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </>
        )}
      </section>
      {dialog}
    </div>
  );
}
