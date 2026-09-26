// Admin V2 governance — role management (SUPER_ADMIN only), custom bans,
// privileged user actions, subscription actions, chargebacks, device/session
// management, login history, and audit reversal.
//
// Design notes:
// - SUPER_ADMIN is the highest privilege and holds every permission plus the
//   exclusive super powers (role management, audit reversal, impersonation,
//   emergency controls, platform config, feature flags).
// - ADMIN (legacy) keeps all existing functionality working and bypasses
//   operational permission checks, but does NOT get super powers.
// - Named operational roles carry server-defined permission bundles
//   (authorization.ts ROLE_PERMISSION_BUNDLES) plus optional per-admin extra
//   grants in users.admin_permissions (SUPER_ADMIN-managed, additive only).
// - Every mutation writes an append-only audit row in the same transaction.
// - Reversible actions carry beforeState/afterState; reversing them is itself
//   a new audited action (SUPER_ADMIN only), never an UPDATE of history.

import type { Prisma, PrismaClient, SubscriptionStatus, UserRole } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import { recordAuditEvent, actorIdentity } from '../audit/service.js';
import { hashPassword } from '../auth/passwords.js';
import { isUserBanned } from '../auth/service.js';
import {
  ALL_PERMISSIONS,
  ADMIN_ROLES,
  isAdminRole,
  isKnownPermission,
  permissionsForRole,
  permissionsForRoleWithLegacy,
  type PermissionKey,
} from '../../http/authorization.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

type Db = PrismaClient;

export interface AdminAccountDto {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  /** Server-defined bundle for the role (before extra grants). */
  bundlePermissions: PermissionKey[];
  /** Extra per-admin grants assigned by a SUPER_ADMIN (additive only). */
  grantedPermissions: PermissionKey[];
  /** Effective permissions: bundle ∪ grants (SUPER_ADMIN/ADMIN: all). */
  effectivePermissions: PermissionKey[];
  createdAt: Date;
}

function toAdminAccountDto(row: {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  adminPermissions: string[];
  createdAt: Date;
}): AdminAccountDto {
  const bundle = permissionsForRole(row.role);
  const granted = row.adminPermissions.filter(isKnownPermission);
  // Display-only; enforcement uses permissionsForRoleWithLegacy/hasPermissions.
  // Legacy ADMIN keeps its fixed pre-existing bundle (no auto-escalation to
  // new Admin V2 powers); only SUPER_ADMIN holds every permission.
  const effective =
    row.role === 'SUPER_ADMIN'
      ? [...ALL_PERMISSIONS]
      : [...new Set([...permissionsForRoleWithLegacy(row.role), ...granted])];
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    bundlePermissions: bundle,
    grantedPermissions: granted,
    effectivePermissions: effective,
    createdAt: row.createdAt,
  };
}

async function getActiveUser(id: string, db: Db) {
  const user = await db.user.findFirst({ where: { id, deletedAt: null } });
  if (!user) throw notFound('User not found.');
  return user;
}

// ---------------------------------------------------------------------------
// Role management (SUPER_ADMIN only — enforced at the route layer).
// ---------------------------------------------------------------------------

const ASSIGNABLE_ROLES: UserRole[] = [
  'LISTENER',
  'ARTIST',
  'PLATFORM_ADMIN',
  'MODERATOR',
  'SUPPORT_ADMIN',
  'FINANCE_ADMIN',
  'CONTENT_ADMIN',
  'ARTIST_ADMIN',
  'ANALYTICS_ADMIN',
  'ADMIN',
  'SUPER_ADMIN',
];

export function getAssignableRoles(): UserRole[] {
  return [...ASSIGNABLE_ROLES];
}

export async function listAdminAccounts(db: Db = prisma): Promise<AdminAccountDto[]> {
  const rows = await db.user.findMany({
    where: { role: { in: ADMIN_ROLES as UserRole[] }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      adminPermissions: true,
      createdAt: true,
    },
  });
  return rows.map(toAdminAccountDto);
}

/**
 * Assign any role (promotion, demotion, or lateral move). SUPER_ADMIN only.
 * Guards: no self-changes; cannot remove the last SUPER_ADMIN; assigning an
 * admin role clears nothing, but dropping to a non-admin role clears extra
 * grants and revokes sessions.
 */
export async function assignAdminRole(
  userId: string,
  role: UserRole,
  actor: AuthUser,
  db: Db = prisma,
): Promise<AdminAccountDto> {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw badRequest(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
  }
  const user = await getActiveUser(userId, db);
  if (user.id === actor.id) {
    throw forbidden('You cannot change your own role. Ask another super admin.');
  }
  if (user.role === role) {
    throw badRequest(`User already has role ${role}.`);
  }
  if (user.role === 'SUPER_ADMIN') {
    // Protect the last super admin: the platform must always have one.
    const superCount = await db.user.count({
      where: { role: 'SUPER_ADMIN', deletedAt: null },
    });
    if (superCount <= 1) {
      throw forbidden('Cannot change the role of the last SUPER_ADMIN account.');
    }
  }
  const before = {
    role: user.role,
    adminPermissions: user.adminPermissions.filter(isKnownPermission),
  };
  const droppingAdmin = isAdminRole(user.role) && !isAdminRole(role);
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        role,
        // Leaving the admin tier clears extra grants so a later
        // re-promotion starts from the role bundle alone.
        adminPermissions: droppingAdmin ? [] : undefined,
      },
    });
    if (droppingAdmin) {
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'user.role.changed',
        targetType: 'user',
        targetId: userId,
        metadata: {
          oldRole: before.role,
          newRole: role,
          sessionsRevoked: droppingAdmin,
        },
        reversible: true,
        beforeState: before,
        afterState: {
          role,
          adminPermissions: droppingAdmin ? [] : before.adminPermissions,
        },
      },
      tx,
    );
    return updated;
  });
  return toAdminAccountDto(row);
}

/**
 * Tiered role change used by PATCH /v1/users/:id/role.
 * - SUPER_ADMIN: full power via assignAdminRole.
 * - ADMIN (legacy): may only move accounts between non-admin roles
 *   (LISTENER <-> ARTIST). Cannot touch admin-role accounts and cannot grant
 *   admin roles — privilege escalation is a SUPER_ADMIN-only power.
 * Every change is audited and reversible.
 */
export async function changeUserRole(
  userId: string,
  role: UserRole,
  actor: AuthUser,
  db: Db = prisma,
): Promise<AdminAccountDto> {
  if (actor.role === 'SUPER_ADMIN') {
    return assignAdminRole(userId, role, actor, db);
  }
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw badRequest(`Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`);
  }
  if (isAdminRole(role)) {
    throw forbidden('Only a SUPER_ADMIN can grant admin roles.');
  }
  const user = await getActiveUser(userId, db);
  if (user.id === actor.id) {
    throw forbidden('You cannot change your own role. Ask another admin.');
  }
  if (isAdminRole(user.role)) {
    throw forbidden('Only a SUPER_ADMIN can change the role of an admin account.');
  }
  const before = {
    role: user.role,
    adminPermissions: user.adminPermissions.filter(isKnownPermission),
  };
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.user.update({ where: { id: userId }, data: { role } });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'user.role.changed',
        targetType: 'user',
        targetId: userId,
        metadata: { oldRole: before.role, newRole: role, via: 'legacy-admin' },
        reversible: true,
        beforeState: before,
        afterState: { role, adminPermissions: before.adminPermissions },
      },
      tx,
    );
    return updated;
  });
  return toAdminAccountDto(row);
}
/**
 * Replace the extra per-admin permission grants (additive on top of the role
 * bundle). SUPER_ADMIN only. Grants are meaningful for legacy ADMIN accounts
 * (which hold only LEGACY_ADMIN_PERMISSIONS by default) and for named roles;
 * SUPER_ADMIN already holds everything so grants there are rejected. Keys
 * outside PERMISSIONS are rejected.
 */
export async function setAdminGrants(
  userId: string,
  permissions: string[],
  actor: AuthUser,
  db: Db = prisma,
): Promise<AdminAccountDto> {
  const user = await getActiveUser(userId, db);
  if (!isAdminRole(user.role)) {
    throw badRequest('Extra grants can only be assigned to admin-role accounts.');
  }
  if (user.role === 'SUPER_ADMIN') {
    throw badRequest('SUPER_ADMIN already holds every permission; grants are unnecessary.');
  }
  if (user.id === actor.id) {
    throw forbidden('You cannot change your own grants.');
  }
  const unknown = permissions.filter((p) => !isKnownPermission(p));
  if (unknown.length > 0) {
    throw badRequest(`Unknown permission keys: ${unknown.join(', ')}.`);
  }
  const deduped = [...new Set(permissions.filter(isKnownPermission))];
  const before = user.adminPermissions.filter(isKnownPermission);
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: { adminPermissions: deduped },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'admin.permissions.changed',
        targetType: 'user',
        targetId: userId,
        metadata: {
          granted: deduped.filter((p) => !before.includes(p)),
          revoked: before.filter((p) => !deduped.includes(p as PermissionKey)),
        },
        reversible: true,
        beforeState: { adminPermissions: before },
        afterState: { adminPermissions: deduped },
      },
      tx,
    );
    return updated;
  });
  return toAdminAccountDto(row);
}

// ---------------------------------------------------------------------------
// Custom bans.
// ---------------------------------------------------------------------------

export interface BanInput {
  reason: string;
  /** Optional temporary ban length in days. Omit for indefinite. */
  durationDays?: number;
}

export async function banUser(
  userId: string,
  input: BanInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  const user = await getActiveUser(userId, db);
  if (user.id === actor.id) {
    throw forbidden('You cannot ban yourself.');
  }
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
    throw forbidden('ADMIN and SUPER_ADMIN accounts cannot be banned. Change their role first.');
  }
  if (isUserBanned(user)) {
    throw badRequest('User is already banned.');
  }
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw badRequest('Ban reason must be at least 3 characters.');
  }
  if (
    input.durationDays !== undefined &&
    (!Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 3650)
  ) {
    throw badRequest('durationDays must be an integer between 1 and 3650.');
  }
  const now = new Date();
  const bannedUntil = input.durationDays
    ? new Date(now.getTime() + input.durationDays * 86_400_000)
    : null;
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { bannedAt: now, banReason: reason, bannedUntil },
    });
    // A banned account's sessions die immediately.
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'user.banned',
        targetType: 'user',
        targetId: userId,
        metadata: {
          bannedUntil: bannedUntil ? bannedUntil.toISOString() : null,
          sessionsRevoked: true,
        },
        reversible: true,
        beforeState: { banned: false },
        afterState: {
          banned: true,
          banReason: reason,
          bannedUntil: bannedUntil ? bannedUntil.toISOString() : null,
        },
      },
      tx,
    );
  });
}

export async function unbanUser(
  userId: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  const user = await getActiveUser(userId, db);
  if (!isUserBanned(user)) {
    throw badRequest('User is not banned.');
  }
  const beforeState = {
    banned: true,
    banReason: user.banReason,
    bannedUntil: user.bannedUntil ? user.bannedUntil.toISOString() : null,
  };
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { bannedAt: null, banReason: null, bannedUntil: null },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'user.unbanned',
        targetType: 'user',
        targetId: userId,
        reversible: true,
        beforeState,
        afterState: { banned: false },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Privileged user actions.
// ---------------------------------------------------------------------------

export async function updateUserEmail(
  userId: string,
  email: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  const user = await getActiveUser(userId, db);
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw badRequest('Invalid email address.');
  }
  if (normalized === user.email) {
    throw badRequest('Email is already set to that value.');
  }
  const clash = await db.user.findUnique({ where: { email: normalized } });
  if (clash && clash.id !== userId) {
    throw badRequest('Another account already uses that email.');
  }
  const beforeEmail = user.email;
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { email: normalized, emailVerified: false },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'user.email.changed',
        targetType: 'user',
        targetId: userId,
        // Facts only: the addresses themselves are PII the admin already sees
        // in the user detail view, and reversal needs them in before/after.
        reversible: true,
        beforeState: { email: beforeEmail },
        afterState: { email: normalized },
      },
      tx,
    );
  });
}

export async function resetUserPassword(
  userId: string,
  newPassword: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  const user = await getActiveUser(userId, db);
  if (user.id === actor.id) {
    throw forbidden('Use your own account settings to change your password.');
  }
  // Same policy as registration: 12..128 chars (schema also enforces).
  if (newPassword.length < 12 || newPassword.length > 128) {
    throw badRequest('Password must be between 12 and 128 characters.');
  }
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    // A credential change invalidates every session except none — the user
    // must log in again everywhere with the new password.
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'user.password.reset',
        targetType: 'user',
        targetId: userId,
        metadata: { sessionsRevoked: true },
        // Not reversible: the old hash is never recoverable by design.
        reversible: false,
      },
      tx,
    );
  });
}

export interface SessionDto {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export async function listUserSessions(userId: string, db: Db = prisma): Promise<SessionDto[]> {
  await getActiveUser(userId, db);
  const rows = await db.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      expiresAt: true,
    },
  });
  return rows;
}

export async function revokeUserSession(
  userId: string,
  sessionId: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  await getActiveUser(userId, db);
  const row = await db.refreshToken.findFirst({
    where: { id: sessionId, userId, revokedAt: null },
  });
  if (!row) {
    throw notFound('Active session not found.');
  }
  await db.$transaction(async (tx) => {
    await tx.refreshToken.update({
      where: { id: sessionId },
      data: { revokedAt: new Date() },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'user.session.revoked',
        targetType: 'user',
        targetId: userId,
        metadata: { sessionId },
        reversible: false,
      },
      tx,
    );
  });
}

/**
 * Force logout: revoke every live session for the user at once.
 * Non-reversible by design (a revoked session cannot be un-revoked safely).
 */
export async function revokeAllUserSessions(
  userId: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<{ revokedCount: number }> {
  await getActiveUser(userId, db);
  if (userId === actor.id) {
    throw forbidden('You cannot force-logout yourself. Use the normal sign-out.');
  }
  const result = await db.$transaction(async (tx) => {
    const res = await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'user.sessions.revoked_all',
        targetType: 'user',
        targetId: userId,
        metadata: { revokedCount: res.count },
        reversible: false,
      },
      tx,
    );
    return res;
  });
  return { revokedCount: result.count };
}

export interface LoginEventDto {
  id: string;
  email: string;
  ipAddress: string | null;
  userAgent: string | null;
  success: boolean;
  failureReason: string | null;
  createdAt: Date;
}

export async function listLoginHistory(
  userId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<LoginEventDto>> {
  await getActiveUser(userId, db);
  const p = parsePagination(query);
  const where = { userId };
  const [rows, total] = await Promise.all([
    db.loginEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.loginEvent.count({ where }),
  ]);
  return pageEnvelope(rows, total, p);
}

// ---------------------------------------------------------------------------
// Subscription actions (permission: subscriptions.manage).
// ---------------------------------------------------------------------------

export interface AdminUpdateSubscriptionInput {
  planId?: string;
  status?: SubscriptionStatus;
  /** ISO-8601. Extending the paid/trial window (grant/extend entitlement). */
  currentPeriodStart?: string;
  /** ISO-8601. Must be after currentPeriodStart when both are set. */
  currentPeriodEnd?: string;
}

async function writeSubscriptionEvent(
  tx: Prisma.TransactionClient,
  subscriptionId: string,
  eventType:
    | 'PLAN_CHANGED'
    | 'SUBSCRIPTION_CANCELED'
    | 'SUBSCRIPTION_REVOKED'
    | 'TRIAL_STARTED'
    | 'TRIAL_CONVERTED',
  statusFrom: SubscriptionStatus | null,
  statusTo: SubscriptionStatus | null,
  provider: 'DEV' | 'APPLE' | 'GOOGLE',
): Promise<void> {
  await tx.subscriptionEvent.create({
    data: {
      subscriptionId,
      provider,
      providerEventId: `admin-${Date.now()}-${eventType.toLowerCase()}`,
      eventType,
      statusFrom,
      statusTo,
      payload: { source: 'admin' },
    },
  });
}

export async function adminUpdateSubscription(
  subscriptionId: string,
  input: AdminUpdateSubscriptionInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  if (
    input.planId === undefined &&
    input.status === undefined &&
    input.currentPeriodStart === undefined &&
    input.currentPeriodEnd === undefined
  ) {
    throw badRequest('Provide planId, status, and/or period dates to change.');
  }
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    include: { user: { select: { id: true, deletedAt: true } } },
  });
  if (!sub || sub.user.deletedAt) {
    throw notFound('Subscription not found.');
  }

  // Validate period dates up front: ISO-8601, end after start, and a grant
  // (ACTIVE/TRIALING) must leave a future window so it actually entitles.
  let periodStart: Date | undefined;
  let periodEnd: Date | undefined;
  if (input.currentPeriodStart !== undefined) {
    periodStart = new Date(input.currentPeriodStart);
    if (Number.isNaN(periodStart.getTime())) throw badRequest('currentPeriodStart is not a valid ISO-8601 date.');
  }
  if (input.currentPeriodEnd !== undefined) {
    periodEnd = new Date(input.currentPeriodEnd);
    if (Number.isNaN(periodEnd.getTime())) throw badRequest('currentPeriodEnd is not a valid ISO-8601 date.');
  }
  const effectiveStart = periodStart ?? sub.currentPeriodStart;
  const effectiveEnd = periodEnd ?? sub.currentPeriodEnd;
  if (effectiveStart && effectiveEnd && effectiveEnd.getTime() <= effectiveStart.getTime()) {
    throw badRequest('currentPeriodEnd must be after currentPeriodStart.');
  }
  const effectiveStatus = input.status ?? sub.status;
  if (
    (effectiveStatus === 'ACTIVE' || effectiveStatus === 'TRIALING') &&
    periodEnd !== undefined &&
    periodEnd.getTime() <= Date.now()
  ) {
    throw badRequest('Granting ACTIVE/TRIALING requires a currentPeriodEnd in the future.');
  }

  const actions: Array<{
    action: string;
    reversible: boolean;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }> = [];

  await db.$transaction(async (tx) => {
    if (input.planId !== undefined && input.planId !== sub.planId) {
      const plan = await tx.plan.findUnique({ where: { id: input.planId } });
      if (!plan) throw badRequest('Plan not found.');
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: { planId: input.planId },
      });
      await writeSubscriptionEvent(
        tx,
        subscriptionId,
        'PLAN_CHANGED',
        null,
        null,
        sub.provider,
      );
      actions.push({
        action: 'subscription.plan.changed',
        reversible: true,
        beforeState: { planId: sub.planId },
        afterState: { planId: input.planId },
      });
    }

    if (input.status !== undefined && input.status !== sub.status) {
      // Main-admin/sub-admin manual override: the transition table guards
      // provider-driven events, but an explicit admin action may force any
      // status (e.g. reactivate after a chargeback dispute is won). The
      // override itself is what gets audited.
      const now = new Date();
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: input.status,
          canceledAt: input.status === 'CANCELED' ? (sub.canceledAt ?? now) : null,
        },
      });
      await writeSubscriptionEvent(
        tx,
        subscriptionId,
        input.status === 'CANCELED' ? 'SUBSCRIPTION_CANCELED' : 'SUBSCRIPTION_REVOKED',
        sub.status,
        input.status,
        sub.provider,
      );
      actions.push({
        action: 'subscription.status.changed',
        reversible: true,
        beforeState: { status: sub.status },
        afterState: { status: input.status },
        metadata: { manualOverride: true },
      });
    }

    if (periodStart !== undefined || periodEnd !== undefined) {
      // Grant/extend/revoke entitlement window. Entitlement itself stays
      // server-derived (resolveEntitlement); this only moves the period the
      // rules read, and every move is audited + reversible.
      const data: { currentPeriodStart?: Date; currentPeriodEnd?: Date } = {};
      if (periodStart !== undefined) data.currentPeriodStart = periodStart;
      if (periodEnd !== undefined) data.currentPeriodEnd = periodEnd;
      await tx.subscription.update({ where: { id: subscriptionId }, data });
      actions.push({
        action: 'subscription.period.changed',
        reversible: true,
        beforeState: {
          currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
        },
        afterState: {
          currentPeriodStart: (periodStart ?? sub.currentPeriodStart)?.toISOString() ?? null,
          currentPeriodEnd: (periodEnd ?? sub.currentPeriodEnd)?.toISOString() ?? null,
        },
        metadata: { manualOverride: true },
      });
    }

    for (const a of actions) {
      await recordAuditEvent(
        {
          ...actorIdentity(actor),
          action: a.action,
          targetType: 'subscription',
          targetId: subscriptionId,
          metadata: { userId: sub.userId, ...(a.metadata ?? {}) },
          reversible: a.reversible,
          beforeState: a.beforeState,
          afterState: a.afterState,
        },
        tx,
      );
    }
  });

  if (actions.length === 0) {
    throw badRequest('No changes: values already match the subscription.');
  }
}

export async function adminSetTrial(
  subscriptionId: string,
  trialing: boolean,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) {
    throw notFound('Subscription not found.');
  }
  const target: SubscriptionStatus = trialing ? 'TRIALING' : 'ACTIVE';
  if (sub.status === target) {
    throw badRequest(`Subscription is already ${target.toLowerCase()}.`);
  }
  // Trial toggles are explicit admin actions; they bypass the provider
  // transition table the same way manual status overrides do.
  await db.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { status: target },
    });
    await writeSubscriptionEvent(
      tx,
      subscriptionId,
      trialing ? 'TRIAL_STARTED' : 'TRIAL_CONVERTED',
      sub.status,
      target,
      sub.provider,
    );
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: trialing ? 'subscription.trial.started' : 'subscription.trial.ended',
        targetType: 'subscription',
        targetId: subscriptionId,
        metadata: { userId: sub.userId, manualOverride: true },
        reversible: true,
        beforeState: { status: sub.status },
        afterState: { status: target },
      },
      tx,
    );
  });
}

export interface ChargebackInput {
  providerRef?: string;
  amountCents?: number;
  currency?: string;
  reason?: string;
}

export async function recordChargeback(
  subscriptionId: string,
  input: ChargebackInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<void> {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) {
    throw notFound('Subscription not found.');
  }
  if (input.amountCents !== undefined && (!Number.isInteger(input.amountCents) || input.amountCents < 0)) {
    throw badRequest('amountCents must be a non-negative integer.');
  }
  if (input.currency !== undefined && !/^[A-Za-z]{3}$/.test(input.currency)) {
    throw badRequest('currency must be a 3-letter code.');
  }
  const now = new Date();
  const wasActive = sub.status !== 'CANCELED';
  await db.$transaction(async (tx) => {
    const chargeback = await tx.chargeback.create({
      data: {
        subscriptionId,
        providerRef: input.providerRef?.trim() || null,
        amountCents: input.amountCents ?? null,
        currency: input.currency?.toUpperCase() ?? null,
        reason: input.reason?.trim() || null,
        recordedBy: actor.id,
      },
    });
    // The chargeback auto-cancels the subscription: disputed money must not
    // keep entitling the account.
    if (wasActive) {
      await tx.subscription.update({
        where: { id: subscriptionId },
        data: { status: 'CANCELED', canceledAt: sub.canceledAt ?? now },
      });
      await writeSubscriptionEvent(
        tx,
        subscriptionId,
        'SUBSCRIPTION_CANCELED',
        sub.status,
        'CANCELED',
        sub.provider,
      );
    }
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: 'subscription.chargeback',
        targetType: 'subscription',
        targetId: subscriptionId,
        metadata: {
          userId: sub.userId,
          chargebackId: chargeback.id,
          autoCanceled: wasActive,
        },
        // Money movement is never silently inverted; a main admin can still
        // manually reactivate the subscription via the status override.
        reversible: false,
      },
      tx,
    );
  });
}

export async function listChargebacks(
  subscriptionId: string,
  db: Db = prisma,
): Promise<
  Array<{
    id: string;
    providerRef: string | null;
    amountCents: number | null;
    currency: string | null;
    reason: string | null;
    createdAt: Date;
  }>
> {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) throw notFound('Subscription not found.');
  return db.chargeback.findMany({
    where: { subscriptionId },
    orderBy: { createdAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Audit reversal (main admin only — enforced at the route layer).
// ---------------------------------------------------------------------------

type ReversalApplier = (
  tx: Prisma.TransactionClient,
  original: {
    targetId: string | null;
    beforeState: Record<string, unknown> | null;
    afterState: Record<string, unknown> | null;
  },
) => Promise<{ targetType: string; restoredSummary: Record<string, unknown> }>;

/** Maps a reversible action to the function that inverts it. */
const REVERSERS: Record<string, ReversalApplier> = {
  'user.banned': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    await tx.user.update({
      where: { id: original.targetId },
      data: { bannedAt: null, banReason: null, bannedUntil: null },
    });
    return { targetType: 'user', restoredSummary: { banned: false } };
  },
  'user.unbanned': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    const before = original.beforeState ?? {};
    const bannedUntil =
      typeof before.bannedUntil === 'string' ? new Date(before.bannedUntil) : null;
    await tx.user.update({
      where: { id: original.targetId },
      data: {
        bannedAt: new Date(),
        banReason:
          typeof before.banReason === 'string' ? before.banReason : 'Ban restored by reversal',
        bannedUntil,
      },
    });
    // Re-banning kills sessions again.
    await tx.refreshToken.updateMany({
      where: { userId: original.targetId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { targetType: 'user', restoredSummary: { banned: true } };
  },
  'user.email.changed': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    const email = original.beforeState?.email;
    if (typeof email !== 'string') throw badRequest('Original email is not recorded.');
    const clash = await tx.user.findUnique({ where: { email } });
    if (clash && clash.id !== original.targetId) {
      throw badRequest('The original email is now taken by another account.');
    }
    await tx.user.update({
      where: { id: original.targetId },
      data: { email, emailVerified: false },
    });
    return { targetType: 'user', restoredSummary: { email } };
  },
  'admin.role.changed': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    const before = original.beforeState ?? {};
    const role = (before as { role?: unknown }).role as UserRole | undefined;
    const validRoles: UserRole[] = [
      'LISTENER',
      'ARTIST',
      'ADMIN',
      'SUPER_ADMIN',
      'PLATFORM_ADMIN',
      'MODERATOR',
      'SUPPORT_ADMIN',
      'FINANCE_ADMIN',
      'CONTENT_ADMIN',
      'ARTIST_ADMIN',
      'ANALYTICS_ADMIN',
    ];
    if (role === undefined || !validRoles.includes(role)) {
      throw badRequest('The original role is not recorded.');
    }
    // Never strand the platform: reversing into a demotion of the last
    // SUPER_ADMIN is refused.
    if (role !== 'SUPER_ADMIN') {
      const target = await tx.user.findUnique({
        where: { id: original.targetId },
        select: { role: true },
      });
      if (target?.role === 'SUPER_ADMIN') {
        const superCount = await tx.user.count({
          where: { role: 'SUPER_ADMIN', deletedAt: null },
        });
        if (superCount <= 1) {
          throw forbidden('Reversal refused: it would remove the last SUPER_ADMIN.');
        }
      }
    }
    const permissions = Array.isArray(before.adminPermissions)
      ? (before.adminPermissions as string[]).filter((p): p is PermissionKey =>
          ALL_PERMISSIONS.includes(p as PermissionKey),
        )
      : [];
    await tx.user.update({
      where: { id: original.targetId },
      data: { role: role as UserRole, adminPermissions: permissions },
    });
    return {
      targetType: 'user',
      restoredSummary: { role, adminPermissions: permissions },
    };
  },
  'admin.permissions.changed': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    const before = original.beforeState?.adminPermissions;
    const permissions = Array.isArray(before)
      ? (before as string[]).filter((p): p is PermissionKey =>
          ALL_PERMISSIONS.includes(p as PermissionKey),
        )
      : [];
    await tx.user.update({
      where: { id: original.targetId },
      data: { adminPermissions: permissions },
    });
    return { targetType: 'user', restoredSummary: { adminPermissions: permissions } };
  },
  'subscription.period.changed': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    const before = original.beforeState ?? {};
    const parse = (v: unknown): Date | null => {
      if (typeof v !== 'string' || v.length === 0) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    await tx.subscription.update({
      where: { id: original.targetId },
      data: {
        currentPeriodStart: parse(before.currentPeriodStart),
        currentPeriodEnd: parse(before.currentPeriodEnd),
      },
    });
    return {
      targetType: 'subscription',
      restoredSummary: {
        currentPeriodStart: before.currentPeriodStart ?? null,
        currentPeriodEnd: before.currentPeriodEnd ?? null,
      },
    };
  },
  'subscription.status.changed': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    const status = original.beforeState?.status;
    if (
      status !== 'ACTIVE' &&
      status !== 'TRIALING' &&
      status !== 'PAST_DUE' &&
      status !== 'CANCELED' &&
      status !== 'EXPIRED' &&
      status !== 'REVOKED'
    ) {
      throw badRequest('The original status is not recorded.');
    }
    const sub = await tx.subscription.findUnique({ where: { id: original.targetId } });
    if (!sub) throw notFound('Subscription not found.');
    await tx.subscription.update({
      where: { id: original.targetId },
      data: {
        status: status as SubscriptionStatus,
        canceledAt: status === 'CANCELED' ? (sub.canceledAt ?? new Date()) : null,
      },
    });
    await writeSubscriptionEvent(
      tx,
      original.targetId,
      'SUBSCRIPTION_REVOKED',
      sub.status,
      status as SubscriptionStatus,
      sub.provider,
    );
    return { targetType: 'subscription', restoredSummary: { status } };
  },
  'subscription.plan.changed': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    const planId = original.beforeState?.planId;
    if (typeof planId !== 'string') throw badRequest('The original plan is not recorded.');
    const plan = await tx.plan.findUnique({ where: { id: planId } });
    if (!plan) throw badRequest('The original plan no longer exists.');
    await tx.subscription.update({
      where: { id: original.targetId },
      data: { planId },
    });
    return { targetType: 'subscription', restoredSummary: { planId } };
  },
  'subscription.trial.started': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    return restoreSubscriptionStatus(tx, original, 'subscription');
  },
  'subscription.trial.ended': async (tx, original) => {
    if (!original.targetId) throw badRequest('Reversal target is missing.');
    return restoreSubscriptionStatus(tx, original, 'subscription');
  },
};

async function restoreSubscriptionStatus(
  tx: Prisma.TransactionClient,
  original: {
    targetId: string | null;
    beforeState: Record<string, unknown> | null;
  },
  targetType: string,
): Promise<{ targetType: string; restoredSummary: Record<string, unknown> }> {
  const status = original.beforeState?.status;
  if (
    status !== 'ACTIVE' &&
    status !== 'TRIALING' &&
    status !== 'PAST_DUE' &&
    status !== 'CANCELED' &&
    status !== 'EXPIRED' &&
    status !== 'REVOKED'
  ) {
    throw badRequest('The original status is not recorded.');
  }
  await tx.subscription.update({
    where: { id: original.targetId! },
    data: { status: status as SubscriptionStatus },
  });
  return { targetType, restoredSummary: { status } };
}

export async function reverseAuditEvent(
  auditId: string,
  actor: AuthUser,
  db: Db = prisma,
): Promise<{ reversedAction: string; restoredSummary: Record<string, unknown> }> {
  const original = await db.adminAuditLog.findUnique({ where: { id: auditId } });
  if (!original) {
    throw notFound('Audit event not found.');
  }
  if (original.reversalOf) {
    throw badRequest('Cannot reverse a reversal. The original action stands reversed.');
  }
  if (!original.reversible) {
    throw badRequest(`Action '${original.action}' is not reversible.`);
  }
  const reverser = REVERSERS[original.action];
  if (!reverser) {
    throw badRequest(`No reverser is implemented for action '${original.action}'.`);
  }
  const alreadyReversed = await db.adminAuditLog.findFirst({
    where: { reversalOf: auditId },
    select: { id: true },
  });
  if (alreadyReversed) {
    throw badRequest('This action has already been reversed.');
  }
  // The main admin cannot reverse an action targeting their own account
  // through this path — use the normal flows instead.
  if (original.targetType === 'user' && original.targetId === actor.id) {
    throw forbidden('You cannot reverse actions on your own account.');
  }

  const result = await db.$transaction(async (tx) => {
    const { targetType, restoredSummary } = await reverser(
      tx,
      {
        targetId: original.targetId,
        beforeState: (original.beforeState ?? null) as Record<string, unknown> | null,
        afterState: (original.afterState ?? null) as Record<string, unknown> | null,
      },
    );
    await recordAuditEvent(
      {
        ...actorIdentity(actor),
        action: `${original.action}.reversed`,
        targetType,
        targetId: original.targetId,
        metadata: { reversedEventId: original.id, restored: restoredSummary },
        reversible: false,
        reversalOf: original.id,
      },
      tx,
    );
    return { reversedAction: original.action, restoredSummary };
  });
  return result;
}
