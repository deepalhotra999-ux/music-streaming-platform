// Phase 4 — authorization helpers. Authentication ("who are you?") is the
// `app.authenticate` guard from http/auth.ts; this module answers "may you?"
// Run role checks AFTER `app.authenticate` in the preHandler chain so
// `request.authUser` is populated.
//
// Admin V2 privilege model:
// - SUPER_ADMIN: highest privilege. Holds every permission AND the exclusive
//   super powers (role management, audit reversal, impersonation, emergency
//   controls, platform config, feature flags).
// - ADMIN: legacy admin. Keeps exactly the pre-existing admin capabilities
//   working via LEGACY_ADMIN_PERMISSIONS below — it does NOT automatically
//   receive new Admin V2 powers (user bans, credential resets, subscription
//   overrides, security/jobs/webhooks centers, finance dashboards, role
//   management, impersonation, flags, settings, emergency controls). A
//   SUPER_ADMIN can grant individual extra permissions per account via
//   `users.admin_permissions`, or migrate the account to a named role.
// - Named operational roles (PLATFORM_ADMIN, MODERATOR, SUPPORT_ADMIN,
//   FINANCE_ADMIN, CONTENT_ADMIN, ARTIST_ADMIN, ANALYTICS_ADMIN): each carries
//   a server-defined permission bundle below, plus optional per-admin extra
//   grants in `users.admin_permissions` (SUPER_ADMIN-managed).
// The frontend is NEVER trusted for authorization; every check below runs
// server-side, reading role + grants fresh from the database so revocations
// take effect immediately.

import type { FastifyRequest } from 'fastify';
import { forbidden } from './errors.js';
import type { AuthUser } from './auth.js';
import { prisma } from '../db.js';

export type Role =
  | 'LISTENER'
  | 'ARTIST'
  | 'ADMIN'
  | 'SUPER_ADMIN'
  | 'PLATFORM_ADMIN'
  | 'MODERATOR'
  | 'SUPPORT_ADMIN'
  | 'FINANCE_ADMIN'
  | 'CONTENT_ADMIN'
  | 'ARTIST_ADMIN'
  | 'ANALYTICS_ADMIN';

export const isAdmin = (user: AuthUser | null | undefined): boolean =>
  user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';

export const isSuperAdmin = (user: AuthUser | null | undefined): boolean =>
  user?.role === 'SUPER_ADMIN';

/**
 * Admin V2 — granular permission keys. Every privileged admin action maps to
 * one or more of these keys and is enforced with `requirePermission`.
 */
export const PERMISSIONS = {
  'users.view': 'View users, login history, devices, and app history',
  'users.edit': 'Edit user profile fields (email, display name)',
  'users.credentials': 'Reset user passwords and revoke sessions',
  'users.ban': 'Ban and unban users',
  'users.impersonate': 'Start an impersonation session (SUPER_ADMIN only in practice)',
  'subscriptions.manage': 'Change plans, toggle trials, cancel/reactivate, record chargebacks',
  'content.moderate': 'Take down / restore / hide catalog content',
  'reports.moderate': 'Review and resolve moderation reports',
  'audit.view': 'View the admin audit log',
  'finance.view': 'View financial dashboards (subscriptions, commerce, royalties)',
  'commerce.manage': 'Manage stores, products, orders, refunds, fulfillment',
  'royalties.manage': 'Inspect runs, reconcile, publish, create adjustments',
  'security.view': 'View the security operations center',
  'jobs.view': 'View the job/processing center',
  'webhooks.view': 'View webhook operations',
  'system.view': 'View system health and the platform timeline',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

/**
 * Server-defined permission bundles for the named operational roles.
 * These are the defaults; a SUPER_ADMIN may add per-admin extra grants via
 * `users.admin_permissions`. Grants are additive only — to narrow access,
 * assign a narrower role.
 */
export const ROLE_PERMISSION_BUNDLES: Record<string, readonly PermissionKey[]> = {
  PLATFORM_ADMIN: ALL_PERMISSIONS,
  MODERATOR: ['users.view', 'users.ban', 'content.moderate', 'reports.moderate'],
  SUPPORT_ADMIN: [
    'users.view',
    'users.edit',
    'users.credentials',
    'subscriptions.manage',
    'commerce.manage',
    'reports.moderate',
  ],
  FINANCE_ADMIN: [
    'users.view',
    'subscriptions.manage',
    'audit.view',
    'finance.view',
    'royalties.manage',
  ],
  CONTENT_ADMIN: ['users.view', 'content.moderate', 'reports.moderate'],
  ARTIST_ADMIN: ['users.view', 'content.moderate', 'reports.moderate'],
  ANALYTICS_ADMIN: ['users.view', 'audit.view', 'system.view'],
};

export function permissionsForRole(role: string): PermissionKey[] {
  return [...(ROLE_PERMISSION_BUNDLES[role] ?? [])];
}

/**
 * Permissions a legacy ADMIN account holds without any explicit grant.
 * This is exactly the set of capabilities that were guarded by
 * `requireRole('ADMIN')` before Admin V2 existed, mapped onto the new keys:
 * user listing/detail (admin console users screen), content moderation
 * (community posts/comments, genres, track takedown), moderation report
 * review, audit log viewing, commerce administration, royalty administration,
 * and the platform analytics overview. Every NEW Admin V2 capability —
 * user bans/credential resets, subscription overrides, security/jobs/webhooks
 * centers, finance dashboards, role management, impersonation, feature flags,
 * platform settings, emergency controls — is deliberately absent: existing
 * ADMIN accounts do not automatically receive new permissions. A SUPER_ADMIN
 * may add per-account grants or migrate the account to a named role.
 */
export const LEGACY_ADMIN_PERMISSIONS: readonly PermissionKey[] = [
  'users.view',
  'content.moderate',
  'reports.moderate',
  'audit.view',
  'commerce.manage',
  'royalties.manage',
  'system.view',
];

/** Resolve the full permission set for a role: bundle (+ legacy bundle). */
export function permissionsForRoleWithLegacy(role: string): PermissionKey[] {
  if (role === 'ADMIN') return [...LEGACY_ADMIN_PERMISSIONS];
  return permissionsForRole(role);
}

export function isKnownPermission(key: string): key is PermissionKey {
  return key in PERMISSIONS;
}

/** All roles that participate in admin access (shown in role-management UI). */
export const ADMIN_ROLES: Role[] = [
  'SUPER_ADMIN',
  'ADMIN',
  'PLATFORM_ADMIN',
  'MODERATOR',
  'SUPPORT_ADMIN',
  'FINANCE_ADMIN',
  'CONTENT_ADMIN',
  'ARTIST_ADMIN',
  'ANALYTICS_ADMIN',
];

export function isAdminRole(role: string): boolean {
  return (ADMIN_ROLES as string[]).includes(role);
}

/**
 * preHandler factory: rejects with 403 unless the caller holds every required
 * permission key. SUPER_ADMIN holds everything; legacy ADMIN holds exactly
 * LEGACY_ADMIN_PERMISSIONS (pre-existing capabilities only — new Admin V2
 * powers are never auto-granted); named roles resolve their bundle plus
 * per-admin grants, read fresh from the database so changes take effect
 * immediately. Run AFTER `app.authenticate` in the preHandler chain.
 */
export function requirePermission(...perms: PermissionKey[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = req.authUser;
    if (!user) {
      throw forbidden('This action requires an authenticated admin.');
    }
    if (user.role === 'SUPER_ADMIN') return;
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { role: true, adminPermissions: true, deletedAt: true },
    });
    if (!row || row.deletedAt || !isAdminRole(row.role)) {
      throw forbidden('Admin access revoked.');
    }
    const held = new Set<PermissionKey>([
      ...permissionsForRoleWithLegacy(row.role),
      ...(row.adminPermissions as PermissionKey[]).filter(isKnownPermission),
    ]);
    const missing = perms.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw forbidden(
        `This action requires the following permissions: ${missing.join(', ')}.`,
      );
    }
  };
}

/**
 * Non-throwing permission check for cases that filter (rather than gate),
 * e.g. global search result types. Mirrors requirePermission's resolution:
 * SUPER_ADMIN holds everything, legacy ADMIN holds LEGACY_ADMIN_PERMISSIONS,
 * named roles resolve bundle + grants fresh from the database.
 */
export async function hasPermissions(
  userId: string,
  role: string,
  ...perms: PermissionKey[]
): Promise<boolean> {
  if (role === 'SUPER_ADMIN') return true;
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, adminPermissions: true, deletedAt: true },
  });
  if (!row || row.deletedAt || !isAdminRole(row.role)) return false;
  const held = new Set<PermissionKey>([
    ...permissionsForRoleWithLegacy(row.role),
    ...(row.adminPermissions as PermissionKey[]).filter(isKnownPermission),
  ]);
  return perms.every((p) => held.has(p));
}

/**
 * Resolve the caller's full effective permission set, fresh from the
 * database (SUPER_ADMIN → everything; legacy ADMIN → LEGACY_ADMIN_PERMISSIONS;
 * named roles → bundle + per-account grants). Used by
 * GET /v1/admin/me/permissions so the admin UI can hide sections the caller
 * cannot use. UI hint only — every endpoint re-checks server-side.
 */
export async function effectivePermissionsFor(userId: string, role: string): Promise<Set<PermissionKey>> {
  if (role === 'SUPER_ADMIN') return new Set<PermissionKey>([...ALL_PERMISSIONS]);
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, adminPermissions: true, deletedAt: true },
  });
  if (!row || row.deletedAt || !isAdminRole(row.role)) return new Set();
  return new Set<PermissionKey>([
    ...permissionsForRoleWithLegacy(row.role),
    ...(row.adminPermissions as PermissionKey[]).filter(isKnownPermission),
  ]);
}

/**
 * preHandler factory: SUPER_ADMIN only. Used for the exclusive super powers:
 * role management, audit reversal, impersonation, emergency controls,
 * platform configuration, feature flags. Role is re-read from the database so
 * a demotion takes effect immediately.
 */
export function requireSuperAdmin() {
  return async (req: FastifyRequest): Promise<void> => {
    const user = req.authUser;
    if (!user) {
      throw forbidden('This action requires an authenticated super admin.');
    }
    if (user.role === 'SUPER_ADMIN') {
      // Re-read: a demoted super admin's JWT must stop working for super powers.
      const row = await prisma.user.findUnique({
        where: { id: user.id },
        select: { role: true, deletedAt: true },
      });
      if (row && !row.deletedAt && row.role === 'SUPER_ADMIN') return;
      throw forbidden('Super admin access revoked.');
    }
    throw forbidden('This action requires the SUPER_ADMIN role.');
  };
}

/**
 * preHandler factory: rejects with 403 unless the caller's role is one of the
 * allowed roles. Combine with `app.authenticate`, e.g.:
 *   preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')]
 */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = req.authUser;
    if (!user || !roles.includes(user.role as Role)) {
      throw forbidden(`This action requires one of the following roles: ${roles.join(', ')}.`);
    }
  };
}

/**
 * preHandler factory: passes when the caller's role is in `roles` OR the
 * caller holds every permission in `perms` (resolved fresh from the database,
 * same semantics as requirePermission). Used where a self-service role and an
 * operational permission overlap — e.g. store owners (ARTIST) refunding their
 * own orders, or support staff holding 'commerce.manage' refunding any order.
 * SUPER_ADMIN always passes via the permission path.
 */
export function requireRoleOrPermission(roles: Role[], ...perms: PermissionKey[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = req.authUser;
    if (!user) {
      throw forbidden('This action requires an authenticated user.');
    }
    if (roles.includes(user.role as Role)) return;
    if (user.role === 'SUPER_ADMIN') return;
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { role: true, adminPermissions: true, deletedAt: true },
    });
    if (!row || row.deletedAt || !isAdminRole(row.role)) {
      throw forbidden('Admin access revoked.');
    }
    const held = new Set<PermissionKey>([
      ...permissionsForRoleWithLegacy(row.role),
      ...(row.adminPermissions as PermissionKey[]).filter(isKnownPermission),
    ]);
    const missing = perms.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw forbidden(
        `This action requires one of the following roles: ${roles.join(', ')}; ` +
          `or the following permissions: ${missing.join(', ')}.`,
      );
    }
  };
}

/** True when the caller owns the artist row or is an admin. */
export function canManageArtist(user: AuthUser, artist: { ownerUserId: string | null }): boolean {
  return isAdmin(user) || artist.ownerUserId === user.id;
}
