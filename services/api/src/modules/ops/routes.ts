// Admin V2 — platform operations center routes.
//
// Read-mostly operational surfaces over real data. Mutations (suspend,
// bulk takedown, flags, settings, impersonation) are confirmed, audited,
// and permission-gated. Nothing here invents data or executes jobs.

import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import type { Config } from '../../config.js';
import { requirePermission, requireSuperAdmin } from '../../http/authorization.js';
import { badRequest } from '../../http/errors.js';
import { problemSchema } from '../../http/errors.js';
import {
  bulkTrackStatus,
  deleteFlag,
  endImpersonation,
  getArtistAdminDetail,
  getCommandCenter,
  getCommerceFinance,
  getJobsOverview,
  getModerationOverview,
  getPlatformTimeline,
  getRoyaltyFinance,
  getSecurityOverview,
  getSubscriptionFinance,
  getSystemHealth,
  getWebhooksOverview,
  globalSearch,
  listAllSessions,
  restoreArtist,
  revokeSessionGlobal,
  setFlag,
  setSetting,
  startImpersonation,
  suspendArtist,
  listFlags,
  listSettings,
} from './service.js';
import { SETTING_DEFINITIONS } from './settings.js';

const uuidParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

interface IdParams {
  id: string;
}

export function opsRoutes(app: FastifyInstance, config: Config): void {
  const auth = app.authenticate;
  const anyAdmin = requirePermission();

  // ---------------------------------------------------------- command center
  app.get(
    '/v1/admin/command-center',
    {
      preHandler: [auth, anyAdmin],
      schema: {
        tags: ['Admin ops'],
        summary: 'Operations command center metrics',
        description:
          'Real platform metrics computed from existing tables and the in-process metrics collector. No invented numbers.',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', additionalProperties: true } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async () => getCommandCenter(),
  );

  // ------------------------------------------------------------------ search
  app.get<{ Querystring: { q: string } }>(
    '/v1/admin/search',
    {
      preHandler: [auth, anyAdmin],
      schema: {
        tags: ['Admin ops'],
        summary: 'Permission-filtered global search',
        description:
          'Searches users, catalog, orders, stores, posts, reports, and audit actions. Each result type is gated on the caller\'s permissions; skipped types are listed in excludedTypes.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', minLength: 2, maxLength: 100 } },
        } as const,
        response: { 200: { type: 'object', additionalProperties: true } as const, 400: problemSchema, 401: problemSchema, 403: problemSchema },
      },
    },
    async (req) => globalSearch(req.query.q, req.authUser!),
  );

  // ---------------------------------------------------------------- timeline
  app.get<{ Querystring: { limit?: string } }>(
    '/v1/admin/timeline',
    {
      preHandler: [auth, requirePermission('system.view')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Global platform timeline',
        description: 'Merged recent activity across admin actions, subscriptions, chargebacks, royalty runs, and reports.',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: { limit: { type: 'string' } },
        } as const,
        response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async (req) => getPlatformTimeline(req.query.limit ? Number(req.query.limit) : 50),
  );

  // ------------------------------------------------------------ artist admin
  app.get<{ Params: IdParams }>(
    '/v1/admin/artists/:id/detail',
    {
      preHandler: [auth, requirePermission('users.view')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Artist control-center detail',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        response: { 200: { type: 'object', additionalProperties: true } as const, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (req) => getArtistAdminDetail(req.params.id),
  );

  app.post<{ Params: IdParams; Body: { reason: string } }>(
    '/v1/admin/artists/:id/suspend',
    {
      preHandler: [auth, requirePermission('content.moderate')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Suspend an artist',
        description:
          'Account-level suspension: the artist, their albums, and their tracks are hidden from public listings. Reversible via restore; history is preserved.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        body: {
          type: 'object',
          required: ['reason'],
          properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
        } as const,
        response: { 204: { type: 'null' }, 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (req, reply) => {
      await suspendArtist(req.params.id, req.body.reason, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  app.post<{ Params: IdParams }>(
    '/v1/admin/artists/:id/restore',
    {
      preHandler: [auth, requirePermission('content.moderate')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Restore a suspended artist',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        response: { 204: { type: 'null' }, 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (req, reply) => {
      await restoreArtist(req.params.id, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  // ------------------------------------------------------------ bulk content
  app.post<{ Body: { ids: string[]; status: 'READY' | 'TAKEDOWN'; reason: string } }>(
    '/v1/admin/tracks/bulk-status',
    {
      preHandler: [auth, requirePermission('content.moderate')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Bulk take down / restore tracks',
        description:
          'Safe bulk action: only READY <-> TAKEDOWN transitions, max 100 tracks, every track gets its own audit row with before/after state.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['ids', 'status', 'reason'],
          properties: {
            ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', format: 'uuid' } },
            status: { type: 'string', enum: ['READY', 'TAKEDOWN'] },
            reason: { type: 'string', minLength: 5, maxLength: 500 },
          },
        } as const,
        response: { 200: { type: 'object', additionalProperties: true } as const, 400: problemSchema, 401: problemSchema, 403: problemSchema },
      },
    },
    async (req) => bulkTrackStatus(req.body.ids, req.body.status, req.body.reason, req.authUser!),
  );

  // ---------------------------------------------------------------- security
  app.get(
    '/v1/admin/security/overview',
    {
      preHandler: [auth, requirePermission('security.view')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Security operations overview',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', additionalProperties: true } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async () => getSecurityOverview(),
  );

  app.get<{ Querystring: { userId?: string; take?: string } }>(
    '/v1/admin/security/sessions',
    {
      preHandler: [auth, requirePermission('security.view')],
      schema: {
        tags: ['Admin ops'],
        summary: 'List active sessions platform-wide',
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: { userId: { type: 'string', format: 'uuid' }, take: { type: 'string' } },
        } as const,
        response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async (req) => listAllSessions(req.query.userId, req.query.take ? Number(req.query.take) : 50),
  );

  app.post<{ Params: IdParams }>(
    '/v1/admin/security/sessions/:id/revoke',
    {
      preHandler: [auth, requirePermission('security.view')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Revoke any active session',
        description: 'Cannot revoke your own current session from here; sign out instead.',
        security: [{ bearerAuth: [] }],
        params: uuidParam,
        response: { 204: { type: 'null' }, 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (req, reply) => {
      await revokeSessionGlobal(req.params.id, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  // -------------------------------------------------------------------- jobs
  app.get(
    '/v1/admin/jobs',
    {
      preHandler: [auth, requirePermission('jobs.view')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Job / processing center',
        description:
          'Surfaces the real processing state that exists (ingestion queue, royalty runs). There is no distributed job queue; failed ingestion is retried via the existing idempotent endpoint.',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', additionalProperties: true } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async () => getJobsOverview(),
  );

  // ---------------------------------------------------------------- webhooks
  app.get(
    '/v1/admin/webhooks',
    {
      preHandler: [auth, requirePermission('webhooks.view')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Webhook operations',
        description:
          'Visibility over applied inbound provider events (subscription + commerce). Delivery is provider-driven; no new retry mechanism is introduced.',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', additionalProperties: true } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async () => getWebhooksOverview(),
  );

  // ------------------------------------------------------------------ health
  app.get(
    '/v1/admin/health',
    {
      preHandler: [auth, requirePermission('system.view')],
      schema: {
        tags: ['Admin ops'],
        summary: 'System health for operators',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', additionalProperties: true } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async () => getSystemHealth(),
  );

  // ------------------------------------------------------------ finance centers
  const financeGuard = requirePermission('finance.view');
  for (const [path, summary, description, handler] of [
    [
      '/v1/admin/finance/subscriptions',
      'Subscription finance',
      'Subscriber counts by status and plan, trials, chargeback totals, and recent subscription events. Plans carry no price in this schema, so no MRR is shown — only real counts.',
      getSubscriptionFinance,
    ],
    [
      '/v1/admin/finance/commerce',
      'Commerce finance',
      'Gross captured revenue (PAID and beyond), refunds, net, orders by status, and recent refunds. All values from real order/refund rows.',
      getCommerceFinance,
    ],
    [
      '/v1/admin/finance/royalties',
      'Royalty finance',
      'Royalty runs with pool/allocated/residual amounts, lifetime totals, and recent append-only adjustments. Runs and payouts remain append-only.',
      getRoyaltyFinance,
    ],
  ] as const) {
    app.get(
      path,
      {
        preHandler: [auth, financeGuard],
        schema: {
          tags: ['Admin ops'],
          summary,
          description,
          security: [{ bearerAuth: [] }],
          response: { 200: { type: 'object', additionalProperties: true } as const, 401: problemSchema, 403: problemSchema },
        },
      },
      handler,
    );
  }

  // ------------------------------------------------------- moderation overview
  app.get(
    '/v1/admin/moderation/overview',
    {
      preHandler: [auth, requirePermission('reports.moderate')],
      schema: {
        tags: ['Admin ops'],
        summary: 'Unified moderation overview',
        description:
          'Queue counts by status and target type, the oldest open report, and recent reports. Review actions stay on the moderation report endpoints.',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'object', additionalProperties: true } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async () => getModerationOverview(),
  );

  // ------------------------------------------------------------ feature flags
  app.get(
    '/v1/admin/flags',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin ops'],
        summary: 'List feature flags',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async () => listFlags(),
  );

  app.put<{ Params: { key: string }; Body: { enabled: boolean; rolloutPercent: number; description?: string } }>(
    '/v1/admin/flags/:key',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin ops'],
        summary: 'Create or update a feature flag',
        description: 'SUPER_ADMIN only. Every change is audited and reversible. Flags carry desired state only — no code execution.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string', minLength: 3, maxLength: 100 } },
        } as const,
        body: {
          type: 'object',
          required: ['enabled', 'rolloutPercent'],
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            rolloutPercent: { type: 'integer', minimum: 0, maximum: 100 },
            description: { type: 'string', maxLength: 500 },
          },
        } as const,
        response: { 204: { type: 'null' }, 400: problemSchema, 401: problemSchema, 403: problemSchema },
      },
    },
    async (req, reply) => {
      await setFlag(req.params.key, req.body, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  app.delete<{ Params: { key: string } }>(
    '/v1/admin/flags/:key',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin ops'],
        summary: 'Delete a feature flag',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string', minLength: 3, maxLength: 100 } },
        } as const,
        response: { 204: { type: 'null' }, 400: problemSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (req, reply) => {
      await deleteFlag(req.params.key, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  // ---------------------------------------------------------- platform settings
  app.get(
    '/v1/admin/settings',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin ops'],
        summary: 'List platform settings with definitions',
        security: [{ bearerAuth: [] }],
        response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } as const, 401: problemSchema, 403: problemSchema },
      },
    },
    async () => listSettings(),
  );

  app.put<{ Params: { key: string }; Body: { value: unknown } }>(
    '/v1/admin/settings/:key',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin ops'],
        summary: 'Change a platform setting',
        description:
          'SUPER_ADMIN only. Strongly typed: unknown keys and out-of-range values are rejected. Emergency keys (emergency.*) are break-glass controls; every change is audited and takes effect immediately.',
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['key'],
          properties: { key: { type: 'string', minLength: 1, maxLength: 100 } },
        } as const,
        body: {
          type: 'object',
          required: ['value'],
          additionalProperties: false,
          properties: { value: {} },
        } as const,
        response: { 204: { type: 'null' }, 400: problemSchema, 401: problemSchema, 403: problemSchema },
      },
    },
    async (req, reply) => {
      if (!(req.params.key in SETTING_DEFINITIONS)) {
        throw badRequest(`Unknown setting key: ${req.params.key}.`);
      }
      await setSetting(req.params.key, req.body.value, req.authUser!);
      return reply.code(204).send(null);
    },
  );

  // ------------------------------------------------------------- impersonation
  app.post<{ Body: { targetUserId: string; reason: string; durationMinutes?: number } }>(
    '/v1/admin/impersonation/start',
    {
      preHandler: [auth, requireSuperAdmin()],
      schema: {
        tags: ['Admin ops'],
        summary: 'Start an impersonation session',
        description:
          'SUPER_ADMIN only. Returns a short-lived token (default 5 min, max 30) that acts as the target user. Admin targets, banned users, and self-impersonation are refused. The session can never access /v1/admin/* and every audit write carries the impersonating admin.',
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          required: ['targetUserId', 'reason'],
          additionalProperties: false,
          properties: {
            targetUserId: { type: 'string', format: 'uuid' },
            reason: { type: 'string', minLength: 10, maxLength: 500 },
            durationMinutes: { type: 'integer', minimum: 1, maximum: 30 },
          },
        } as const,
        response: {
          200: { type: 'object', additionalProperties: true } as const,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (req) => {
      const secret = new TextEncoder().encode(config.jwtSecret);
      return startImpersonation(req.body, req.authUser!, {
        sign: async (payload, expiresInMinutes) =>
          new jose.SignJWT({ ...payload })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setIssuer(config.jwtIssuer)
            .setAudience(config.jwtAudience)
            .setExpirationTime(`${expiresInMinutes}m`)
            .sign(secret),
      });
    },
  );

  app.post(
    '/v1/admin/impersonation/end',
    {
      preHandler: [auth],
      schema: {
        tags: ['Admin ops'],
        summary: 'End the current impersonation session',
        description:
          'Call with the impersonation token. Records impersonation.ended in the audit log; the client must then discard the token.',
        security: [{ bearerAuth: [] }],
        response: { 204: { type: 'null' }, 400: problemSchema, 401: problemSchema },
      },
    },
    async (req, reply) => {
      await endImpersonation(req.authUser!);
      return reply.code(204).send(null);
    },
  );
}
