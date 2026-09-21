// Phase 17 — moderation foundation. HTTP routes. Thin ADMIN-only handlers
// over the moderation service. No DELETE: reports are never removed; a
// wrongly closed report is superseded by filing a new one.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf } from '../../http/pagination.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import {
  createModerationReportBody,
  moderationListQuery,
  moderationReportSchema,
  updateModerationReportBody,
} from './schemas.js';
import {
  createModerationReport,
  getModerationReport,
  listModerationReports,
  updateModerationReport,
  validateReportInput,
  type CreateModerationReportInput,
  type ListModerationReportsQuery,
  type UpdateModerationReportInput,
} from './service.js';

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const moderationErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  422: problemSchema,
};

export async function moderationRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.post<{ Body: CreateModerationReportInput }>(
    '/v1/admin/moderation-reports',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'File a moderation report',
        description:
          'Admin-only. Flags an artist, album, or track for operator review. ' +
          'The target must exist. Writes a moderation.report.created audit row.',
        security: [{ bearerAuth: [] }],
        body: createModerationReportBody,
        response: { 201: moderationReportSchema, ...moderationErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      validateReportInput(req.body);
      const report = await createModerationReport(req.body, req.authUser!);
      return reply.code(201).send(report);
    },
  );

  app.get(
    '/v1/admin/moderation-reports',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'List moderation reports',
        description:
          'Admin-only. Paginated reports with status, target type, and target ' +
          'filters. Newest first.',
        security: [{ bearerAuth: [] }],
        querystring: moderationListQuery,
        response: { 200: pageOf(moderationReportSchema), 401: problemSchema, 403: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as ListModerationReportsQuery;
      return reply.code(200).send(await listModerationReports(query));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/admin/moderation-reports/:id',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Get a moderation report',
        description: 'Admin-only. Returns a single moderation report by id.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { 200: moderationReportSchema, 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getModerationReport(req.params.id));
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateModerationReportInput }>(
    '/v1/admin/moderation-reports/:id',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Update a moderation report',
        description:
          'Admin-only. Changes status (OPEN -> UNDER_REVIEW | RESOLVED | ' +
          'DISMISSED; UNDER_REVIEW -> back to OPEN, RESOLVED, or DISMISSED) ' +
          'and/or edits reason and details. RESOLVED and DISMISSED are ' +
          'terminal. Writes moderation.report.status_changed and/or ' +
          'moderation.report.updated audit rows.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: updateModerationReportBody,
        response: { 200: moderationReportSchema, ...moderationErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      validateReportInput(req.body);
      const report = await updateModerationReport(req.params.id, req.body, req.authUser!);
      return reply.code(200).send(report);
    },
  );
}
