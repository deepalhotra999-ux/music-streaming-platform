// Phase 16 — user management: search, role filter, paginated table,
// detail view, and role changes behind explicit confirmation.
// Credentials and tokens are never displayed.
// Admin V2 — user control center: ban/unban (reason required), sessions
// (revoke one/all), login history, app history, email/password admin
// actions, subscription override, trial grant, chargeback recording.
// Every action is gated by its permission key; the server re-checks.

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/PermissionsContext';
import { apiErrorMessage } from '../api/client';
import {
  getAdminUserDetail,
  getAdminUserSubscription,
  listUsers,
  updateUserRole,
} from '../api/users';
import {
  banUser,
  getUserAppHistory,
  getUserLoginHistory,
  listChargebacks,
  listUserSessions,
  recordChargeback,
  resetUserPassword,
  revokeAllUserSessions,
  revokeUserSession,
  setSubscriptionTrial,
  setUserEmail,
  unbanUser,
  updateSubscription,
} from '../api/governance';
import type {
  AdminSubscriptionDetail,
  AdminUserDetail,
  AppHistoryItem,
  Chargeback,
  LoginEvent,
  PermissionKey,
  UserRole,
  UserSession,
} from '../api/types';
import type { UserListQuery } from '../api/users';
import { useApiList } from '../hooks/useApiList';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Pagination } from '../components/Pagination';
import { AccountStatusBadge, RoleBadge, SubscriptionStatusBadge } from '../components/Badges';
import { useConfirm } from '../components/ConfirmDialog';
import { useReason } from '../components/ReasonDialog';
import { RequirePermission } from '../components/PermissionGate';
import { formatDate, formatMoney } from '../utils/format';

const ROLES: (UserRole | '')[] = ['', 'LISTENER', 'ARTIST', 'ADMIN'];
const PAGE_SIZE = 20;

export function UsersPage(): React.ReactNode {
  return (
    <RequirePermission perm="users.view">
      <UsersContent />
    </RequirePermission>
  );
}

function UsersContent(): React.ReactNode {
  const { client } = useAuth();
  const location = useLocation();
  const [searchInput, setSearchInput] = useState('');
  const [roleInput, setRoleInput] = useState<UserRole | ''>('');
  const [includeDeletedInput, setIncludeDeletedInput] = useState(false);
  // Admin V2 — deep link from global search: /users with { userId } state.
  const [selectedId, setSelectedId] = useState<string | null>(
    (location.state as { userId?: string } | null)?.userId ?? null,
  );

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
                      <th scope="col">Display name</th>
                      <th scope="col">Email</th>
                      <th scope="col">Role</th>
                      <th scope="col">Status</th>
                      <th scope="col">Verified</th>
                      <th scope="col">Created</th>
                      <th scope="col">Actions</th>
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
                            aria-label={`View user ${user.displayName}`}
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
  const { can } = usePermissions();
  const { confirm, dialog } = useConfirm();
  const { askReason, dialog: reasonDialog } = useReason();
  const [user, setUser] = useState<AdminUserDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<UserRole>('LISTENER');
  const [saving, setSaving] = useState(false);
  // Phase 18 — subscription inspection (read-only).
  const [subscription, setSubscription] = useState<AdminSubscriptionDetail | null>(null);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState<unknown>(null);
  // Admin V2 — governance state.
  const [banned, setBanned] = useState(false);
  const [sessions, setSessions] = useState<UserSession[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [loginHistory, setLoginHistory] = useState<LoginEvent[] | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [appHistory, setAppHistory] = useState<AppHistoryItem[] | null>(null);
  const [appLoading, setAppLoading] = useState(false);
  const [chargebacks, setChargebacks] = useState<Chargeback[] | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [subStatusDraft, setSubStatusDraft] = useState('');
  const [subPlanDraft, setSubPlanDraft] = useState('');
  const [chargebackCents, setChargebackCents] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAdminUserDetail(client, id);
      setUser(result);
      setRoleDraft(result.role as UserRole);
      setEmailDraft(result.email);
      setBanned(!!result.bannedAt);
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
      const result = await getAdminUserSubscription(client, id);
      setSubscription(result);
      if (result?.subscription) {
        setSubStatusDraft(result.subscription.status);
        setSubPlanDraft(result.subscription.planId);
        const cbs = await listChargebacks(client, result.subscription.id).catch(() => null);
        setChargebacks(cbs);
      }
    } catch (err) {
      setSubError(err);
    } finally {
      setSubLoading(false);
    }
  }, [client, id]);

  const loadSessions = useCallback(async () => {
    if (!can('users.edit')) return;
    setSessionsLoading(true);
    try {
      setSessions(await listUserSessions(client, id));
    } catch {
      setSessions(null);
    } finally {
      setSessionsLoading(false);
    }
  }, [client, id, can]);

  const loadLoginHistory = useCallback(async () => {
    setLoginLoading(true);
    try {
      const page = await getUserLoginHistory(client, id, { limit: 50 });
      setLoginHistory(page.data);
    } catch {
      setLoginHistory(null);
    } finally {
      setLoginLoading(false);
    }
  }, [client, id]);

  const loadAppHistory = useCallback(async () => {
    setAppLoading(true);
    try {
      const page = await getUserAppHistory(client, id, { limit: 50 });
      setAppHistory(page.data);
    } catch {
      setAppHistory(null);
    } finally {
      setAppLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadSubscription();
  }, [loadSubscription]);

  function noteOk(message: string): void {
    setActionError(null);
    setActionOk(message);
  }

  function noteError(err: unknown): void {
    setActionOk(null);
    setActionError(apiErrorMessage(err));
  }

  async function handleRoleChange(): Promise<void> {
    if (!user || roleDraft === user.role) return;
    setActionError(null);
    setActionOk(null);
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
      setUser({ ...user, role: updated.role });
      onChanged();
      noteOk('Role updated.');
    } catch (err) {
      noteError(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleBan(): Promise<void> {
    if (!user) return;
    const reason = await askReason({
      title: `Ban ${user.displayName}?`,
      message: `${user.email} will be blocked from signing in and all sessions revoked. This is recorded in the audit log and is reversible.`,
      reasonPlaceholder: 'Why is this account being banned?…',
      confirmLabel: 'Ban user',
    });
    if (!reason) return;
    try {
      await banUser(client, user.id, { reason });
      setBanned(true);
      noteOk('User banned.');
    } catch (err) {
      noteError(err);
    }
  }

  async function handleUnban(): Promise<void> {
    if (!user) return;
    const confirmed = await confirm({
      title: `Unban ${user.displayName}?`,
      message: `${user.email} will be able to sign in again. This is recorded in the audit log.`,
      confirmLabel: 'Unban user',
    });
    if (!confirmed) return;
    try {
      await unbanUser(client, user.id);
      setBanned(false);
      noteOk('User unbanned.');
    } catch (err) {
      noteError(err);
    }
  }

  async function handleRevokeSession(sessionId: string): Promise<void> {
    if (!user) return;
    const confirmed = await confirm({
      title: 'Revoke this session?',
      message: 'The device behind this session will be signed out immediately.',
      confirmLabel: 'Revoke session',
    });
    if (!confirmed) return;
    try {
      await revokeUserSession(client, user.id, sessionId);
      await loadSessions();
      noteOk('Session revoked.');
    } catch (err) {
      noteError(err);
    }
  }

  async function handleRevokeAllSessions(): Promise<void> {
    if (!user) return;
    const confirmed = await confirm({
      title: `Revoke all sessions for ${user.displayName}?`,
      message:
        'Every device will be signed out immediately, including the current one if it belongs to this user.',
      confirmLabel: 'Revoke all sessions',
    });
    if (!confirmed) return;
    try {
      await revokeAllUserSessions(client, user.id);
      await loadSessions();
      noteOk('All sessions revoked.');
    } catch (err) {
      noteError(err);
    }
  }

  async function handleEmailUpdate(): Promise<void> {
    if (!user || !emailDraft.trim() || emailDraft.trim() === user.email) return;
    const confirmed = await confirm({
      title: 'Update email address?',
      message: `${user.email} will become ${emailDraft.trim()}. The user must verify the new address.`,
      confirmLabel: 'Update email',
    });
    if (!confirmed) return;
    try {
      await setUserEmail(client, user.id, emailDraft.trim());
      setUser({ ...user, email: emailDraft.trim() });
      noteOk('Email updated.');
    } catch (err) {
      noteError(err);
    }
  }

  async function handlePasswordReset(): Promise<void> {
    if (!user || passwordDraft.length < 12) {
      setActionError('New password must be at least 12 characters.');
      return;
    }
    const confirmed = await confirm({
      title: `Reset password for ${user.displayName}?`,
      message:
        'The current password stops working immediately. Share the new password with the user through a secure channel — it is never shown again.',
      confirmLabel: 'Reset password',
    });
    if (!confirmed) return;
    try {
      await resetUserPassword(client, user.id, passwordDraft);
      setPasswordDraft('');
      noteOk('Password reset. The new password was accepted; it is not displayed.');
    } catch (err) {
      noteError(err);
    }
  }

  async function handleSubscriptionOverride(): Promise<void> {
    const sub = subscription?.subscription;
    if (!sub) return;
    const input: { planId?: string; status?: string } = {};
    if (subPlanDraft.trim() && subPlanDraft.trim() !== sub.planId)
      input.planId = subPlanDraft.trim();
    if (subStatusDraft && subStatusDraft !== sub.status) input.status = subStatusDraft;
    if (Object.keys(input).length === 0) return;
    const confirmed = await confirm({
      title: 'Override subscription?',
      message: `Subscription ${sub.id} will be updated: ${JSON.stringify(input)}. Entitlement recomputes from the new state. This is recorded in the audit log.`,
      confirmLabel: 'Apply override',
    });
    if (!confirmed) return;
    try {
      await updateSubscription(client, sub.id, input);
      await loadSubscription();
      noteOk('Subscription overridden.');
    } catch (err) {
      noteError(err);
    }
  }

  async function handleTrial(trialing: boolean): Promise<void> {
    const sub = subscription?.subscription;
    if (!sub) return;
    const confirmed = await confirm({
      title: trialing ? 'Start trial?' : 'End trial?',
      message: trialing
        ? `${user?.displayName}'s subscription will enter a trial period.`
        : 'The trial will end immediately and the subscription resumes its normal status.',
      confirmLabel: trialing ? 'Start trial' : 'End trial',
    });
    if (!confirmed) return;
    try {
      await setSubscriptionTrial(client, sub.id, trialing);
      await loadSubscription();
      noteOk(trialing ? 'Trial started.' : 'Trial ended.');
    } catch (err) {
      noteError(err);
    }
  }

  async function handleChargeback(): Promise<void> {
    const sub = subscription?.subscription;
    if (!sub) return;
    const cents = Number.parseInt(chargebackCents, 10);
    if (!Number.isFinite(cents) || cents < 1) {
      setActionError('Chargeback amount must be a positive number of cents.');
      return;
    }
    const reason = await askReason({
      title: 'Record chargeback?',
      message: `${formatMoney(cents, 'USD')} will be recorded as a chargeback against subscription ${sub.id}. Chargeback records are append-only and cannot be edited.`,
      reasonPlaceholder: 'Chargeback reason (required)…',
      confirmLabel: 'Record chargeback',
    });
    if (!reason) return;
    try {
      await recordChargeback(client, sub.id, { amountCents: cents, reason });
      setChargebackCents('');
      const cbs = await listChargebacks(client, sub.id).catch(() => null);
      setChargebacks(cbs);
      noteOk('Chargeback recorded.');
    } catch (err) {
      noteError(err);
    }
  }

  if (loading) return <LoadingState label="Loading user…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!user) return <EmptyState message="User not found." />;

  const gated = (perm: PermissionKey): boolean => can(perm);

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
      {actionOk && (
        <div className="success-banner" role="status">
          {actionOk}
        </div>
      )}
      <div className="card">
        <h2>
          {user.displayName} <AccountStatusBadge deletedAt={user.deletedAt} />{' '}
          {banned && <span className="badge badge-red">Banned</span>}
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
        {gated('users.ban') && (
          <div className="toolbar" style={{ marginTop: 12 }}>
            {banned ? (
              <button type="button" className="btn" onClick={() => void handleUnban()}>
                Unban user
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-outline-danger"
                onClick={() => void handleBan()}
              >
                Ban user…
              </button>
            )}
          </div>
        )}
      </div>

      {user.ownedArtists.length > 0 && (
        <div className="card">
          <h2>Owned artists ({user.ownedArtists.length})</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Verified</th>
                  <th scope="col">Created</th>
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
              <div className="detail-item">
                <p className="detail-label">Store product ID</p>
                <p className="detail-value mono">
                  {subscription.subscription.storeProductId ?? '—'}
                </p>
              </div>
              <div className="detail-item">
                <p className="detail-label">Store verification</p>
                <p className="detail-value">
                  {subscription.subscription.verificationStatus === 'VERIFIED' ? (
                    <span className="badge badge-green">Verified</span>
                  ) : (
                    <span className="badge badge-gray">Unverified</span>
                  )}
                </p>
              </div>
              {subscription.latestEvent && (
                <div className="detail-item">
                  <p className="detail-label">Latest event</p>
                  <p className="detail-value mono">
                    {subscription.latestEvent.eventType}
                    {subscription.latestEvent.createdAt
                      ? ` — ${formatDate(subscription.latestEvent.createdAt)}`
                      : ''}
                  </p>
                </div>
              )}
            </div>

            {subscription.events.length > 0 && (
              <>
                <h3>Event history ({subscription.events.length})</h3>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col">From</th>
                        <th scope="col">To</th>
                        <th scope="col">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subscription.events.map((event) => (
                        <tr key={event.id}>
                          <td className="mono">{event.eventType}</td>
                          <td className="mono">{event.statusFrom ?? '—'}</td>
                          <td className="mono">{event.statusTo ?? '—'}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatDate(event.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {gated('subscriptions.manage') && (
              <>
                <h3>Subscription override</h3>
                <div className="toolbar">
                  <div className="field">
                    <label htmlFor="sub-status">Status</label>
                    <select
                      id="sub-status"
                      value={subStatusDraft}
                      onChange={(event) => setSubStatusDraft(event.target.value)}
                    >
                      {['ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'EXPIRED', 'REVOKED'].map(
                        (s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="sub-plan">Plan ID</label>
                    <input
                      id="sub-plan"
                      type="text"
                      value={subPlanDraft}
                      onChange={(event) => setSubPlanDraft(event.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleSubscriptionOverride()}
                  >
                    Apply override
                  </button>
                </div>

                <h3>Trial</h3>
                <div className="toolbar">
                  <button type="button" className="btn" onClick={() => void handleTrial(true)}>
                    Start trial
                  </button>
                  <button type="button" className="btn" onClick={() => void handleTrial(false)}>
                    End trial
                  </button>
                </div>

                <h3>Chargebacks</h3>
                {chargebacks && chargebacks.length > 0 ? (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Amount</th>
                          <th scope="col">Reason</th>
                          <th scope="col">Recorded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chargebacks.map((cb) => (
                          <tr key={cb.id}>
                            <td>
                              {cb.amountCents !== null
                                ? formatMoney(cb.amountCents, cb.currency ?? 'USD')
                                : '—'}
                            </td>
                            <td>{cb.reason ?? '—'}</td>
                            <td>{formatDate(cb.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">No chargebacks recorded.</p>
                )}
                <div className="toolbar">
                  <div className="field">
                    <label htmlFor="chargeback-cents">Amount (cents)</label>
                    <input
                      id="chargeback-cents"
                      type="number"
                      min={1}
                      placeholder="e.g. 999"
                      value={chargebackCents}
                      onChange={(event) => setChargebackCents(event.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-outline-danger"
                    onClick={() => void handleChargeback()}
                  >
                    Record chargeback…
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {gated('users.view') && (
        <div className="card">
          <h2>Sessions</h2>
          {sessions === null && !sessionsLoading ? (
            <button type="button" className="btn" onClick={() => void loadSessions()}>
              Load sessions
            </button>
          ) : sessionsLoading ? (
            <LoadingState label="Loading sessions…" />
          ) : sessions && sessions.length > 0 ? (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Created</th>
                      <th scope="col">Expires</th>
                      <th scope="col">IP</th>
                      <th scope="col">User agent</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session) => (
                      <tr key={session.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(session.createdAt)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(session.expiresAt)}</td>
                        <td className="mono">{session.ipAddress ?? '—'}</td>
                        <td className="muted" style={{ maxWidth: 280 }}>
                          {session.userAgent ?? '—'}
                        </td>
                        <td>
                          {gated('users.credentials') ? (
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => void handleRevokeSession(session.id)}
                            >
                              Revoke
                            </button>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {gated('users.credentials') && (
                <div className="toolbar" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn btn-outline-danger"
                    onClick={() => void handleRevokeAllSessions()}
                  >
                    Revoke all sessions
                  </button>
                </div>
              )}
            </>
          ) : (
            <EmptyState message="No active sessions." />
          )}
        </div>
      )}

      <div className="card">
        <h2>Login history</h2>
        {loginHistory === null && !loginLoading ? (
          <button type="button" className="btn" onClick={() => void loadLoginHistory()}>
            Load login history
          </button>
        ) : loginLoading ? (
          <LoadingState label="Loading login history…" />
        ) : loginHistory && loginHistory.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Result</th>
                  <th scope="col">IP</th>
                  <th scope="col">User agent</th>
                </tr>
              </thead>
              <tbody>
                {loginHistory.map((event) => (
                  <tr key={event.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(event.createdAt)}</td>
                    <td>
                      {event.success ? (
                        <span className="badge badge-green">Success</span>
                      ) : (
                        <span className="badge badge-red" title={event.failureReason ?? ''}>
                          Failed
                        </span>
                      )}
                    </td>
                    <td className="mono">{event.ipAddress ?? '—'}</td>
                    <td className="muted" style={{ maxWidth: 280 }}>
                      {event.userAgent ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="No login events." />
        )}
      </div>

      <div className="card">
        <h2>App / listening history</h2>
        {appHistory === null && !appLoading ? (
          <button type="button" className="btn" onClick={() => void loadAppHistory()}>
            Load app history
          </button>
        ) : appLoading ? (
          <LoadingState label="Loading app history…" />
        ) : appHistory && appHistory.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Played at</th>
                  <th scope="col">Track ID</th>
                </tr>
              </thead>
              <tbody>
                {appHistory.map((item) => (
                  <tr key={item.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(item.playedAt)}</td>
                    <td className="mono">{item.trackId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="No app history." />
        )}
      </div>

      {(gated('users.edit') || gated('users.credentials')) && (
        <div className="card">
          <h2>Account administration</h2>
          {gated('users.edit') && (
            <>
              <h3>Change email</h3>
              <div className="toolbar">
                <div className="field">
                  <label htmlFor="admin-email">New email</label>
                  <input
                    id="admin-email"
                    type="email"
                    value={emailDraft}
                    onChange={(event) => setEmailDraft(event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={!emailDraft.trim() || emailDraft.trim() === user.email}
                  onClick={() => void handleEmailUpdate()}
                >
                  Update email
                </button>
              </div>
            </>
          )}
          {gated('users.credentials') && (
            <>
              <h3>Reset password</h3>
              <div className="toolbar">
                <div className="field">
                  <label htmlFor="admin-password">New password (min 12 chars)</label>
                  <input
                    id="admin-password"
                    type="password"
                    autoComplete="new-password"
                    value={passwordDraft}
                    onChange={(event) => setPasswordDraft(event.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-outline-danger"
                  disabled={passwordDraft.length < 12}
                  onClick={() => void handlePasswordReset()}
                >
                  Reset password
                </button>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                The new password is never displayed after reset — share it with the user through a
                secure channel.
              </p>
            </>
          )}
        </div>
      )}

      {(currentAdmin?.role === 'ADMIN' || currentAdmin?.role === 'SUPER_ADMIN') && (
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
            Consumer-role changes only. Assigning admin-tier roles requires SUPER_ADMIN and happens
            on the Roles page. This is recorded in the audit log.
          </p>
        </div>
      )}
      {dialog}
      {reasonDialog}
    </div>
  );
}
