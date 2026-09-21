// Phase 16 — user management: search, role filter, paginated table,
// detail view, and role changes behind explicit confirmation.
// Credentials and tokens are never displayed.

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import { getUser, listUsers, updateUserRole } from '../api/users';
import type { AdminUser, UserRole } from '../api/types';
import type { UserListQuery } from '../api/users';
import { useApiList } from '../hooks/useApiList';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Pagination } from '../components/Pagination';
import { RoleBadge } from '../components/Badges';
import { useConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/format';

const ROLES: (UserRole | '')[] = ['', 'LISTENER', 'ARTIST', 'ADMIN'];
const PAGE_SIZE = 20;

export function UsersPage(): React.ReactNode {
  const { client } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [roleInput, setRoleInput] = useState<UserRole | ''>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetcher = useCallback(
    (query: UserListQuery) => listUsers(client, { ...query, limit: PAGE_SIZE }),
    [client],
  );
  const list = useApiList(fetcher, { page: 1 } as UserListQuery);

  function handleSearch(event: FormEvent): void {
    event.preventDefault();
    list.setQuery({ q: searchInput.trim() || undefined, role: roleInput || undefined });
  }

  function clearFilters(): void {
    setSearchInput('');
    setRoleInput('');
    list.setQuery({ q: undefined, role: undefined });
  }

  return (
    <div>
      <div className="page-header">
        <h1>Users</h1>
      </div>

      {selectedId ? (
        <UserDetail id={selectedId} onBack={() => setSelectedId(null)} onChanged={list.reload} />
      ) : (
        <>
          <form className="toolbar" onSubmit={handleSearch}>
            <div className="field search-input">
              <label htmlFor="users-search">Search</label>
              <input
                id="users-search"
                type="search"
                placeholder="Name or email…"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="users-role">Role</label>
              <select
                id="users-role"
                value={roleInput}
                onChange={(event) => setRoleInput(event.target.value as UserRole | '')}
              >
                {ROLES.map((role) => (
                  <option key={role || 'all'} value={role}>
                    {role || 'All roles'}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn">
              Search
            </button>
            <button type="button" className="btn" onClick={clearFilters}>
              Clear
            </button>
          </form>

          {list.loading ? (
            <LoadingState label="Loading users…" />
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={list.reload} />
          ) : list.data.length === 0 ? (
            <EmptyState message="No users match the current filters." />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Display name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Verified</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.map((user) => (
                      <tr key={user.id}>
                        <td>{user.displayName}</td>
                        <td className="mono">{user.email}</td>
                        <td>
                          <RoleBadge role={user.role} />
                        </td>
                        <td>{user.emailVerified ? 'Yes' : 'No'}</td>
                        <td>{formatDate(user.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setSelectedId(user.id)}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {list.pagination && <Pagination pagination={list.pagination} onPage={list.setPage} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

function UserDetail({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => void;
}): React.ReactNode {
  const { client, user: currentAdmin } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<UserRole>('LISTENER');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getUser(client, id);
      setUser(result);
      setRoleDraft(result.role);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRoleChange(): Promise<void> {
    if (!user || roleDraft === user.role) return;
    setActionError(null);
    if (user.id === currentAdmin?.id && roleDraft !== 'ADMIN') {
      setActionError('You cannot remove your own ADMIN role.');
      return;
    }
    const confirmed = await confirm({
      title: `Change role to ${roleDraft}?`,
      message: `${user.displayName} (${user.email}) will change from ${user.role} to ${roleDraft}. This is a privileged change and is recorded in the audit log.`,
      confirmLabel: `Change to ${roleDraft}`,
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const updated = await updateUserRole(client, user.id, roleDraft);
      setUser(updated);
      onChanged();
    } catch (err) {
      setActionError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading user…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!user) return <EmptyState message="User not found." />;

  return (
    <div>
      <button type="button" className="link-button back-link" onClick={onBack}>
        ← Back to users
      </button>
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="card">
        <h2>{user.displayName}</h2>
        <div className="detail-grid">
          <div className="detail-item">
            <p className="detail-label">Email</p>
            <p className="detail-value mono">{user.email}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Role</p>
            <p className="detail-value">
              <RoleBadge role={user.role} />
            </p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Email verified</p>
            <p className="detail-value">{user.emailVerified ? 'Yes' : 'No'}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Country</p>
            <p className="detail-value">{user.countryCode ?? '—'}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">User ID</p>
            <p className="detail-value mono">{user.id}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Created</p>
            <p className="detail-value">{formatDate(user.createdAt)}</p>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Change role</h2>
        <div className="toolbar">
          <div className="field">
            <label htmlFor="user-role-select">New role</label>
            <select
              id="user-role-select"
              value={roleDraft}
              onChange={(event) => setRoleDraft(event.target.value as UserRole)}
            >
              {(['LISTENER', 'ARTIST', 'ADMIN'] as const).map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-outline-danger"
            disabled={roleDraft === user.role || saving}
            onClick={() => void handleRoleChange()}
          >
            {saving ? 'Saving…' : 'Change role'}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Role changes take effect on the user&apos;s next token refresh. This is a privileged
          action and is recorded in the audit log.
        </p>
      </div>
      {dialog}
    </div>
  );
}
