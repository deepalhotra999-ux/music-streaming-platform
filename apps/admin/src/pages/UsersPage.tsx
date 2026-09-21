// Phase 16 — user management: search, role filter, paginated table,
// detail view, and role changes behind explicit confirmation.
// Credentials and tokens are never displayed.

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import {
  getAdminUserDetail,
  getAdminUserSubscription,
  listUsers,
  updateUserRole,
} from '../api/users';
import type { AdminSubscriptionDetail, AdminUserDetail, UserRole } from '../api/types';
import type { UserListQuery } from '../api/users';
import { useApiList } from '../hooks/useApiList';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Pagination } from '../components/Pagination';
import { AccountStatusBadge, RoleBadge, SubscriptionStatusBadge } from '../components/Badges';
import { useConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/format';

const ROLES: (UserRole | '')[] = ['', 'LISTENER', 'ARTIST', 'ADMIN'];
const PAGE_SIZE = 20;

export function UsersPage(): React.ReactNode {
  const { client } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [roleInput, setRoleInput] = useState<UserRole | ''>('');
  const [includeDeletedInput, setIncludeDeletedInput] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fetcher = useCallback(
    (query: UserListQuery) => listUsers(client, { ...query, limit: PAGE_SIZE }),
    [client],
  );
  const list = useApiList(fetcher, { page: 1 } as UserListQuery);

  function handleSearch(event: FormEvent): void {
    event.preventDefault();
    list.setQuery({
      q: searchInput.trim() || undefined,
      role: roleInput || undefined,
      includeDeleted: includeDeletedInput || undefined,
    });
  }

  function clearFilters(): void {
    setSearchInput('');
    setRoleInput('');
    setIncludeDeletedInput(false);
    list.setQuery({ q: undefined, role: undefined, includeDeleted: undefined });
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
            <div className="field checkbox-field">
              <label htmlFor="users-include-deleted">
                <input
                  id="users-include-deleted"
                  type="checkbox"
                  checked={includeDeletedInput}
                  onChange={(event) => setIncludeDeletedInput(event.target.checked)}
                />{' '}
                Include deleted
              </label>
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
                      <th>Status</th>
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
                        <td>
                          <AccountStatusBadge deletedAt={user.deletedAt} />
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
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<UserRole>('LISTENER');
  const [saving, setSaving] = useState(false);
  // Phase 18 — subscription inspection (read-only).
  const [subscription, setSubscription] = useState<AdminSubscriptionDetail | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAdminUserDetail(client, id);
      setUser(result);
      setRoleDraft(result.role);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  const loadSubscription = useCallback(async () => {
    setSubLoading(true);
    setSubError(null);
    try {
      setSubscription(await getAdminUserSubscription(client, id));
    } catch (err) {
      setSubError(err);
    } finally {
      setSubLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSubscription();
  }, [loadSubscription]);

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
      // updateUserRole returns the base AdminUser shape; keep the richer
      // detail state (ownedArtists, updatedAt) and just apply the new role.
      setUser({ ...user, role: updated.role });
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
        <h2>
          {user.displayName} <AccountStatusBadge deletedAt={user.deletedAt} />
        </h2>
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
          <div className="detail-item">
            <p className="detail-label">Updated</p>
            <p className="detail-value">{formatDate(user.updatedAt)}</p>
          </div>
          {user.deletedAt && (
            <div className="detail-item">
              <p className="detail-label">Deleted</p>
              <p className="detail-value">{formatDate(user.deletedAt)}</p>
            </div>
          )}
        </div>
      </div>
      {user.ownedArtists.length > 0 && (
        <div className="card">
          <h2>Owned artists ({user.ownedArtists.length})</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Verified</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {user.ownedArtists.map((artist) => (
                  <tr key={artist.id}>
                    <td>{artist.name}</td>
                    <td>{artist.verified ? 'Yes' : 'No'}</td>
                    <td>{formatDate(artist.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="card">
        <h2>Subscription</h2>
        {subLoading ? (
          <LoadingState label="Loading subscription…" />
        ) : subError ? (
          <ErrorState error={subError} onRetry={() => void loadSubscription()} />
        ) : !subscription?.subscription ? (
          <EmptyState message="No subscription on file." />
        ) : (
          <>
            <div className="detail-grid">
              <div className="detail-item">
                <p className="detail-label">Status</p>
                <p className="detail-value">
                  <SubscriptionStatusBadge status={subscription.subscription.status} />
                </p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Plan</p>
                <p className="detail-value">{subscription.subscription.plan.name}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Provider</p>
                <p className="detail-value">{subscription.subscription.provider}</p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Playback entitlement</p>
                <p className="detail-value">
                  {subscription.entitlement.entitled ? (
                    <span className="badge badge-green">Entitled</span>
                  ) : (
                    <span className="badge badge-gray">Not entitled</span>
                  )}
                </p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Current period ends</p>
                <p className="detail-value">
                  {subscription.subscription.currentPeriodEnd
                    ? formatDate(subscription.subscription.currentPeriodEnd)
                    : '—'}
                </p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Subscription ID</p>
                <p className="detail-value mono">{subscription.subscription.id}</p>
              </div>
            </div>
            {subscription.events.length > 0 && (
              <>
                <h3>Event history ({subscription.events.length})</h3>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>From</th>
                        <th>To</th>
                        <th>At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subscription.events.map((event) => (
                        <tr key={event.id}>
                          <td className="mono">{event.eventType}</td>
                          <td>{event.statusFrom ?? '—'}</td>
                          <td>{event.statusTo ?? '—'}</td>
                          <td>{formatDate(event.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
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
