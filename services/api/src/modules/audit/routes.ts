// Phase 16 — admin audit. HTTP routes. Thin read-only handlers over the
// audit service. Only GET exists: audit rows are append-only, so no
// POST/PUT/PATCH/DELETE is exposed. Listing is ADMIN-only.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf } from '../../http/pagination.js';
import { requirePermission } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import { auditEventSchema, auditListQuery } from './schemas.js';
import { listAuditEvents, type ListAuditEventsQuery } from './service.js';

export async function auditRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get(
    '/v1/admin/audit-logs',
    {
      preHandler: [app.authenticate, requirePermission('audit.view')],
      schema: {
        tags: ['Admin'],
        summary: 'List admin audit log',
        description:
          'Admin-only. Append-only log of privileged actions (role changes, ' +
          'artist verification, ...). Supports filters and pagination. Rows ' +
          'are immutable: there is no write endpoint for this resource.',
        security: [{ bearerAuth: [] }],
        querystring: auditListQuery,
        response: {
          200: pageOf(auditEventSchema),
          401: problemSchema,
          403: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as ListAuditEventsQuery;
      return reply.code(200).send(await listAuditEvents(query));
    },
  );
}
