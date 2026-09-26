// Admin V2 — governance API wrappers (user control, roles, subscriptions).
//
// Thin wrappers over the backend governance routes. Paths verified against
// services/api/src/modules/governance/routes.ts. Every mutating call is
// server-authorized, validated, reasoned, and audited; the UI never invents
// identifiers or semantics.

import type { ApiClient } from './client';
import type {
  AdminAccount,
  AppHistoryItem,
  Chargeback,
  LoginEvent,
  Page,
  PermissionKey,
  ReversalResult,
  RoleCatalog,
  UserSession,
} from './types';

/** GET /v1/admin/admins — every admin account with bundle, grants, and effective permissions. */
export async function listAdminAccounts(client: ApiClient): Promise<AdminAccount[]> {
  return client.get<AdminAccount[]>('/v1/admin/admins');
}

/** GET /v1/admin/roles — role catalog: every role, its bundle, every permission key. */
export async function getRoleCatalog(client: ApiClient): Promise<RoleCatalog> {
  return client.get<RoleCatalog>('/v1/admin/roles');
}

/** PATCH /v1/users/:id/role — assign a role (SUPER_ADMIN, or legacy ADMIN for tiered roles). */
export async function assignRole(
  client: ApiClient,
  userId: string,
  role: string,
): Promise<AdminAccount> {
  return client.patch<AdminAccount>(`/v1/users/${userId}/role`, { role });
}

/** PUT /v1/admin/users/:id/grants — replace additive per-account grants (SUPER_ADMIN only). */
export async function replaceGrants(
  client: ApiClient,
  userId: string,
  permissions: PermissionKey[],
): Promise<AdminAccount> {
  return client.put<AdminAccount>(`/v1/admin/users/${userId}/grants`, { permissions });
}

/** POST /v1/admin/users/:id/ban — ban with a mandatory reason. */
export async function banUser(
  client: ApiClient,
  userId: string,
  input: { reason: string; durationDays?: number },
): Promise<void> {
  await client.post<unknown>(`/v1/admin/users/${userId}/ban`, input);
}

/** POST /v1/admin/users/:id/unban — unban. */
export async function unbanUser(client: ApiClient, userId: string): Promise<void> {
  await client.post<unknown>(`/v1/admin/users/${userId}/unban`, {});
}

/**
 * GET /v1/admin/users/:id/sessions — active refresh-token sessions.
 * Returns only session fields (id, ipAddress, userAgent, createdAt, expiresAt).
 */
export async function listUserSessions(client: ApiClient, userId: string): Promise<UserSession[]> {
  return client.get<UserSession[]>(`/v1/admin/users/${userId}/sessions`);
}

/** DELETE /v1/admin/users/:id/sessions/:sessionId — revoke one session. */
export async function revokeUserSession(
  client: ApiClient,
  userId: string,
  sessionId: string,
): Promise<void> {
  await client.delete<unknown>(`/v1/admin/users/${userId}/sessions/${sessionId}`);
}

/** POST /v1/admin/users/:id/sessions/revoke-all — revoke every session. */
export async function revokeAllUserSessions(client: ApiClient, userId: string): Promise<void> {
  await client.post<unknown>(`/v1/admin/users/${userId}/sessions/revoke-all`, {});
}

/** GET /v1/admin/users/:id/login-history — recent login events (paged). */
export async function getLoginHistory(
  client: ApiClient,
  userId: string,
  query: { limit?: number } = {},
): Promise<Page<LoginEvent>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return client.get<Page<LoginEvent>>(
    `/v1/admin/users/${userId}/login-history${qs ? `?${qs}` : ''}`,
  );
}

/** GET /v1/admin/users/:id/app-history — recent app activity events (paged). */
export async function getAppHistory(
  client: ApiClient,
  userId: string,
  query: { limit?: number } = {},
): Promise<Page<AppHistoryItem>> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return client.get<Page<AppHistoryItem>>(
    `/v1/admin/users/${userId}/app-history${qs ? `?${qs}` : ''}`,
  );
}

/** PATCH /v1/admin/users/:id/email — admin email change (audited, reversible). */
export async function adminUpdateEmail(
  client: ApiClient,
  userId: string,
  email: string,
): Promise<void> {
  await client.patch<unknown>(`/v1/admin/users/${userId}/email`, { email });
}

/** POST /v1/admin/users/:id/password — admin password reset (never returns the password). */
export async function adminResetPassword(
  client: ApiClient,
  userId: string,
  newPassword: string,
): Promise<void> {
  await client.post<unknown>(`/v1/admin/users/${userId}/password`, { newPassword });
}

/** PATCH /v1/admin/subscriptions/:id — manual subscription override (204). */
export async function overrideSubscription(
  client: ApiClient,
  subscriptionId: string,
  input: {
    planId?: string;
    status?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
  },
): Promise<void> {
  await client.patch<unknown>(`/v1/admin/subscriptions/${subscriptionId}`, input);
}

/**
 * POST /v1/admin/subscriptions/:id/trial — start or end a manual trial (204).
 *
 * The backend models trial as a status toggle (`{ trialing: boolean }`).
 */
export async function grantTrial(
  client: ApiClient,
  subscriptionId: string,
  trialing: boolean,
): Promise<void> {
  await client.post<unknown>(`/v1/admin/subscriptions/${subscriptionId}/trial`, { trialing });
}

/** POST /v1/admin/subscriptions/:id/chargeback — record a chargeback (204, auto-cancels). */
export async function recordChargeback(
  client: ApiClient,
  subscriptionId: string,
  input: { amountCents: number; currency?: string; providerRef?: string; reason?: string },
): Promise<void> {
  await client.post<unknown>(`/v1/admin/subscriptions/${subscriptionId}/chargeback`, input);
}

/** GET /v1/admin/subscriptions/:id/chargebacks — chargeback records, newest first. */
export async function listChargebacks(
  client: ApiClient,
  subscriptionId: string,
): Promise<Chargeback[]> {
  return client.get<Chargeback[]>(`/v1/admin/subscriptions/${subscriptionId}/chargebacks`);
}

/**
 * POST /v1/admin/audit-logs/:id/reverse — SUPER_ADMIN append-only reversal.
 * Takes no body: the server restores the pre-action state recorded in the
 * audit row and appends the reversal as a new row.
 */
export async function reverseAuditLog(client: ApiClient, auditId: string): Promise<ReversalResult> {
  return client.post<ReversalResult>(`/v1/admin/audit-logs/${auditId}/reverse`);
}

// -- Naming aliases -----------------------------------------------------------
// The page layer has used several names for the same endpoints during
// development. These aliases keep every import variant resolving to the
// single canonical implementation above.

/** Alias of {@link assignRole}. */
export const setUserRole = assignRole;
/** Alias of {@link replaceGrants}. */
export const setUserGrants = replaceGrants;
/** Alias of {@link adminResetPassword}. */
export const resetUserPassword = adminResetPassword;
/** Alias of {@link adminUpdateEmail}. */
export const setUserEmail = adminUpdateEmail;
/** Alias of {@link getLoginHistory}. */
export const getUserLoginHistory = getLoginHistory;
/** Alias of {@link getAppHistory}. */
export const getUserAppHistory = getAppHistory;
/** Alias of {@link overrideSubscription}. */
export const updateSubscription = overrideSubscription;
/** Alias of {@link grantTrial}. */
export const setSubscriptionTrial = grantTrial;
/** Alias of {@link listChargebacks}. */
export const getUserChargebacks = listChargebacks;
/** Alias of {@link reverseAuditLog}. */
export const reverseAuditEvent = reverseAuditLog;
