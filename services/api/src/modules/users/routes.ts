// Phase 4 — users. HTTP routes. Thin handlers over the user service.

import type { FastifyInstance } from 'fastify';
import type { UserRole } from '@prisma/client';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, type PaginationQuery } from '../../http/pagination.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import {
  publicUserSchema,
  updateMeBody,
  updateRoleBody,
  userListQuery,
  userProfileSchema,
} from './schemas.js';
import {
  getUserProfile,
  listUsers,
  updateMe,
  updateUserRole,
  type ListUsersQuery,
  type UpdateMeInput,
} from './service.js';

interface IdParams {
  id: string;
}

const idParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export async function usersRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);

  app.get<{ Querystring: PaginationQuery & { q?: string; role?: UserRole } }>(
    '/v1/users',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Users'],
        summary: 'List users',
        description: 'Admin-only paginated user listing. Supports text search and role filter.',
        security: [{ bearerAuth: [] }],
        querystring: userListQuery,
        response: {
          200: pageOf(publicUserSchema),
          401: problemSchema,
          403: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as ListUsersQuery;
      return reply.code(200).send(await listUsers(query));
    },
  );

  app.get<{ Params: IdParams }>(
    '/v1/users/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Get user profile',
        description:
          'Public profile of any user. The email address is only included when ' +
          'the viewer is the user themselves or an admin.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: {
          200: userProfileSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getUserProfile(req.params.id, req.authUser!));
    },
  );

  app.patch<{ Body: UpdateMeInput }>(
    '/v1/users/me',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Users'],
        summary: 'Update my profile',
        description: 'Updates the display name, avatar URL, or country of the caller.',
        security: [{ bearerAuth: [] }],
        body: updateMeBody,
        response: {
          200: publicUserSchema,
          400: problemSchema,
          401: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await updateMe(req.authUser!.id, req.body));
    },
  );

  app.patch<{ Params: IdParams; Body: { role: UserRole } }>(
    '/v1/users/:id/role',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Users'],
        summary: "Change a user's role",
        description:
          'Admin-only. Promotes or demotes a user (e.g. LISTENER to ARTIST). ' +
          'Admins cannot change their own role.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        body: updateRoleBody,
        response: {
          200: publicUserSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply
        .code(200)
        .send(await updateUserRole(req.params.id, req.body.role, req.authUser!));
    },
  );
}
