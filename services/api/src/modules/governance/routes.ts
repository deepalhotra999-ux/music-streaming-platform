// Admin V2 governance — HTTP routes. Thin handlers over the governance service.
//
// Guard model:
// - Role management + audit reversal: requireSuperAdmin() — SUPER_ADMIN only.
//   These are the powers no other admin may grant themselves.
// - Everything else: requirePermission('<key>'). SUPER_ADMIN and ADMIN pass
//   via bypass; named operational roles pass only with the key in their
//   bundle or extra grants.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, type PaginationQuery } from '../../http/pagination.js';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ADMIN_ROLES,
  effectivePermissionsFor,
  permissionsForRole,
  requirePermission,
  requireSuperAdmin,
} from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import { listHistory } from '../history/service.js';
import {
  adminAccountSchema,
  banBody,
  chargebackBody,
  chargebackSchema,
  grantPermissionsBody,
  loginEventSchema,
  paginationQuery,
  resetPasswordBody,
  reversalResultSchema,
  roleCatalogSchema,
  sessionSchema,
  setTrialBody,
  updateEmailBody,
  updateSubscriptionBody,
  uuidParam,
} from './schemas.js';
import {
  adminSetTrial,
  adminUpdateSubscription,
  banUser,
  getAssignableRoles,
  listAdminAccounts,
  listChargebacks,
  listLoginHistory,
  listUserSessions,
  recordChargeback,
  resetUserPassword,
  reverseAuditEvent,
  revokeAllUserSessions,
  revokeUserSession,
  setAdminGrants,
  unbanUser,
  updateUserEmail,
  type BanInput,
  type ChargebackInput,
} from './service.js';

interface IdParams {
  id: string;
}

export async function governanceRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);
  const auth = app.authenticate;

  // -- Caller's own permissions (for permission-aware admin UI) ---------------

  app.get(
    '/v1/admin/me/permissions',
    {
      preHandler: [auth],
      schema: {
        tags: ['Admin governance'],
        summary: "Get the caller's effective admin permissions",
        description:
          'Returns the caller role plus the effective permission set resolved fresh from the database (role bundle + legacy bundle + per-account grants). UI hint only — every endpoint re-checks server-side.',
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            required: ['role', 'permissions'],
            properties: {
              role: { type: 'string' },
              permissions: { type: 'array', items: { type: 'string' } },
            },
          } as const,
          401: problemSchema,
          403: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const me = req.authUser!;
      const perms = await effectivePermissionsFor(me.id, me.role);
      return reply.code(200).send({ role: me.role, permissions: [...perms] });
    },
  );

  // -- Role management (SUPER_ADMIN only) ------------------------------------

  app.get(
    '/v1/admin/admins',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin governance'],
        summary: 'List admin accounts',
        description:
          'SUPER_ADMIN-only. Every account holding an admin role, with its role bundle, extra grants, and effective permissions.',
        security: [{ bearerAuth: [] }],
        response: {
          200: { type: 'array', items: adminAccountSchema },
          401: problemSchema,
          403: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (_req, reply) => reply.code(200).send(await listAdminAccounts()),
  );

  app.get(
    '/v1/admin/roles',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin governance'],
        summary: 'Role and permission catalog',
        description:
          'SUPER_ADMIN-only. The admin roles, their server-defined permission bundles, and the full permission catalog.',
        security: [{ bearerAuth: [] }],
        response: {
          200: roleCatalogSchema,
          401: problemSchema,
          403: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (_req, reply) =>
      reply.code(200).send({
        roles: ADMIN_ROLES.map((role) => ({
          role,
          bundlePermissions: permissionsForRole(role),
        })),
        permissions: ALL_PERMISSIONS.map((key) => ({
          key,
          description: PERMISSIONS[key],
        })),
        assignableRoles: getAssignableRoles(),
      }),
  );

  app.put<{ Params: IdParams; Body: { permissions: string[] } }>(
    '/v1/admin/users/:id/grants',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin governance'],
        summary: 'Set an admin’s extra permission grants',
        description:
          'SUPER_ADMIN-only. Replaces the additive per-admin grants on top of the role bundle. Takes effect immediately; audited and reversible.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        body: grantPermissionsBody,
        response: {
          200: adminAccountSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) =>
      reply
        .code(200)
        .send(await setAdminGrants(req.params.id, req.body.permissions, req.authUser!)),
  );

  // Full role assignment for SUPER_ADMIN lives on the tiered endpoint
  // PATCH /v1/users/:id/role, which delegates to assignAdminRole.

  // -- Bans ------------------------------------------------------------------

  app.post<{ Params: IdParams; Body: BanInput }>(
    '/v1/admin/users/:id/ban',
    {
      preHandler: [auth, requirePermission('users.ban')],
      schema: {
        tags: ['Admin governance'],
        summary: 'Ban a user',
        description:
          'Bans with a required reason and optional duration. Login and token refresh are refused while banned; live sessions are revoked immediately.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        body: banBody,
        response: {
          204: { type: 'null' },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await banUser(req.params.id, req.body, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  app.post<{ Params: IdParams }>(
    '/v1/admin/users/:id/unban',
    {
      preHandler: [auth, requirePermission('users.ban')],
      schema: {
        tags: ['Admin governance'],
        summary: 'Unban a user',
        description: 'Lifts a ban. The user can log in again immediately.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        response: {
          204: { type: 'null' },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await unbanUser(req.params.id, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  // -- Privileged user actions -------------------------------------------------

  app.patch<{ Params: IdParams; Body: { email: string } }>(
    '/v1/admin/users/:id/email',
    {
      preHandler: [auth, requirePermission('users.edit')],
      schema: {
        tags: ['Admin governance'],
        summary: "Change a user's email",
        description:
          'Sets a new unique email and clears email verification. Reversible from the audit log.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        body: updateEmailBody,
        response: {
          204: { type: 'null' },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await updateUserEmail(req.params.id, req.body.email, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  app.post<{ Params: IdParams; Body: { newPassword: string } }>(
    '/v1/admin/users/:id/password',
    {
      preHandler: [auth, requirePermission('users.credentials')],
      schema: {
        tags: ['Admin governance'],
        summary: "Reset a user's password",
        description:
          'Sets a new password (same 12..128 policy as registration) and revokes all of the user’s sessions.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        body: resetPasswordBody,
        response: {
          204: { type: 'null' },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await resetUserPassword(req.params.id, req.body.newPassword, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  app.get<{ Params: IdParams }>(
    '/v1/admin/users/:id/sessions',
    {
      preHandler: [auth, requirePermission('users.view')],
      schema: {
        tags: ['Admin governance'],
        summary: "List a user's active sessions",
        description:
          'Active devices: live refresh tokens with the IP and user-agent each was minted from.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        response: {
          200: { type: 'array', items: sessionSchema },
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => reply.code(200).send(await listUserSessions(req.params.id)),
  );

  app.delete<{ Params: { id: string; sessionId: string } }>(
    '/v1/admin/users/:id/sessions/:sessionId',
    {
      preHandler: [auth, requirePermission('users.credentials')],
      schema: {
        tags: ['Admin governance'],
        summary: 'Revoke a user session',
        description: 'Signs a single device out remotely.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['id', 'sessionId'],
          additionalProperties: false,
          properties: {
            id: { type: 'string', format: 'uuid' },
            sessionId: { type: 'string', format: 'uuid' },
          },
        } as const,
        response: {
          204: { type: 'null' },
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await revokeUserSession(req.params.id, req.params.sessionId, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  app.post<{ Params: IdParams }>(
    '/v1/admin/users/:id/sessions/revoke-all',
    {
      preHandler: [auth, requirePermission('users.credentials')],
      schema: {
        tags: ['Admin governance'],
        summary: 'Force logout all sessions',
        description:
          'Revokes every live session for the user at once. Audited; cannot be undone.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        response: {
          200: {
            type: 'object',
            required: ['revokedCount'],
            properties: { revokedCount: { type: 'integer', minimum: 0 } },
          } as const,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await revokeAllUserSessions(req.params.id, req.authUser!));
    },
  );

  app.get<{ Params: IdParams; Querystring: PaginationQuery }>(
    '/v1/admin/users/:id/login-history',
    {
      preHandler: [auth, requirePermission('users.view')],
      schema: {
        tags: ['Admin governance'],
        summary: "List a user's login history",
        description:
          'Every login attempt with IP, user-agent, and failure reason. Newest first.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        querystring: paginationQuery,
        response: {
          200: pageOf(loginEventSchema),
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) =>
      reply.code(200).send(await listLoginHistory(req.params.id, req.query)),
  );

  app.get<{ Params: IdParams; Querystring: PaginationQuery }>(
    '/v1/admin/users/:id/app-history',
    {
      preHandler: [auth, requirePermission('users.view')],
      schema: {
        tags: ['Admin governance'],
        summary: "List a user's app history",
        description: 'Listening history: what the user played and when. Newest first.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        querystring: paginationQuery,
        response: {
          200: pageOf({
            type: 'object',
            required: ['id', 'trackId', 'playedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              trackId: { type: 'string', format: 'uuid' },
              playedAt: { type: 'string', format: 'date-time' },
            },
          } as const),
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) =>
      reply.code(200).send(await listHistory(req.params.id, req.query)),
  );

  // -- Subscription actions ----------------------------------------------------

  app.patch<{ Params: IdParams; Body: { planId?: string; status?: string; currentPeriodStart?: string; currentPeriodEnd?: string } }>(
    '/v1/admin/subscriptions/:id',
    {
      preHandler: [auth, requirePermission('subscriptions.manage')],
      schema: {
        tags: ['Admin governance'],
        summary: 'Change subscription plan, status, and/or entitlement window',
        description:
          'Manual override: changes plan, forces any status (including reactivation), and/or moves the entitlement period (grant temporary entitlement, extend, revoke). All changes are audited and reversible. Entitlement itself stays server-derived.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        body: updateSubscriptionBody,
        response: {
          204: { type: 'null' },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await adminUpdateSubscription(
        req.params.id,
        req.body as {
          planId?: string;
          status?: import('@prisma/client').SubscriptionStatus;
          currentPeriodStart?: string;
          currentPeriodEnd?: string;
        },
        req.authUser!,
      );
      return reply.code(204).send(null);
    },
  );

  app.post<{ Params: IdParams; Body: { trialing: boolean } }>(
    '/v1/admin/subscriptions/:id/trial',
    {
      preHandler: [auth, requirePermission('subscriptions.manage')],
      schema: {
        tags: ['Admin governance'],
        summary: 'Toggle a subscription trial',
        description: 'Starts or ends the trial period manually.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        body: setTrialBody,
        response: {
          204: { type: 'null' },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await adminSetTrial(req.params.id, req.body.trialing, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  app.post<{ Params: IdParams; Body: ChargebackInput }>(
    '/v1/admin/subscriptions/:id/chargeback',
    {
      preHandler: [auth, requirePermission('subscriptions.manage')],
      schema: {
        tags: ['Admin governance'],
        summary: 'Record a chargeback',
        description:
          'Records a chargeback and auto-cancels the subscription: disputed money must not keep entitling the account.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        body: chargebackBody,
        response: {
          204: { type: 'null' },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      await recordChargeback(req.params.id, req.body, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  app.get<{ Params: IdParams }>(
    '/v1/admin/subscriptions/:id/chargebacks',
    {
      preHandler: [auth, requirePermission('subscriptions.manage')],
      schema: {
        tags: ['Admin governance'],
        summary: 'List subscription chargebacks',
        description: 'Chargeback records for a subscription, newest first.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        response: {
          200: { type: 'array', items: chargebackSchema },
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => reply.code(200).send(await listChargebacks(req.params.id)),
  );

  // -- Audit reversal (SUPER_ADMIN only) ----------------------------------------

  app.post<{ Params: IdParams }>(
    '/v1/admin/audit-logs/:id/reverse',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin governance'],
        summary: 'Reverse an audited admin action',
        description:
          'SUPER_ADMIN-only. Inverts a reversible action (ban, email change, grant change, subscription change, ...) by applying its recorded before-state. The reversal is itself a new audit row; history is never rewritten.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        response: {
          200: reversalResultSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) =>
      reply.code(200).send(await reverseAuditEvent(req.params.id, req.authUser!)),
  );
}
