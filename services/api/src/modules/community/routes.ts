// Phase 29 — artist/fan community. HTTP routes: thin handlers over the
// community service. Identity always comes from the authenticated request;
// write endpoints additionally enforce per-USER rate buckets (server
// identity, not IP) on top of the platform IP bucket.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { pageOf, type PaginationQuery } from '../../http/pagination.js';
import { requireRole } from '../../http/authorization.js';
import { apiRateLimit } from '../../http/limits.js';
import { communityLimits } from './service.js';
import { checkUserRateLimit } from './rateLimit.js';
import {
  artistPostSchema,
  communityListQuery,
  createCommentBody,
  createCommunityReportBody,
  createPostBody,
  idParams,
  postCommentSchema,
  postIdParams,
  updatePostBody,
} from './schemas.js';
import {
  addReaction,
  createComment,
  createPost,
  deleteComment,
  deletePost,
  getCommentForAdmin,
  getCommunityFeed,
  getPost,
  getPostForAdmin,
  listArtistPosts,
  listComments,
  moderateComment,
  moderatePost,
  removeReaction,
  restoreComment,
  restorePost,
  updatePost,
  type CreatePostInput,
  type UpdatePostInput,
} from './service.js';
import {
  createModerationReport,
  validateReportInput,
  type CreateModerationReportInput,
} from '../moderation/service.js';
import { moderationReportSchema } from '../moderation/schemas.js';

const communityErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
  429: problemSchema,
};

const reactionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reacted', 'reactionCount'],
  properties: {
    reacted: { type: 'boolean' },
    reactionCount: { type: 'number' },
  },
} as const;

export async function communityRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limit = apiRateLimit(config);
  const limits = communityLimits(config);
  const windowMs = config.rateLimits.windowMs;
  const userBucket = (userId: string, action: string, max: number): void =>
    checkUserRateLimit(userId, action, max, windowMs);

  // ------------------------------------------------------------ posts ---

  app.post<{ Body: CreatePostInput }>(
    '/v1/community/posts',
    {
      preHandler: [app.authenticate, requireRole('ARTIST')],
      schema: {
        tags: ['Community'],
        summary: 'Create an artist post',
        description:
          'ARTIST-only. Publishes a post as an artist the caller owns, ' +
          'with optional track/album attachments (IDs only; must belong to ' +
          'the same artist and the track must be READY). Per-user rate ' +
          'limited; identical reposts inside the duplicate window are ' +
          'rejected.',
        security: [{ bearerAuth: [] }],
        body: createPostBody,
        response: { 201: artistPostSchema, ...communityErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'community.post_create', config.rateLimits.communityPostCreate);
      const post = await createPost(req.authUser!, req.body, limits);
      return reply.code(201).send(post);
    },
  );

  app.get<{ Params: { postId: string } }>(
    '/v1/community/posts/:postId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'Get an artist post',
        description:
          'Authenticated. ACTIVE posts are visible to everyone; REMOVED ' +
          'or DELETED posts are visible to the author and ADMIN only.',
        security: [{ bearerAuth: [] }],
        params: postIdParams,
        response: { 200: artistPostSchema, 401: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getPost(req.authUser!, req.params.postId));
    },
  );

  app.patch<{ Params: { postId: string }; Body: UpdatePostInput }>(
    '/v1/community/posts/:postId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'Edit an artist post',
        description:
          'Author or ADMIN. Authors can edit ACTIVE posts; editing a ' +
          'moderated post requires an admin restore first. Catalog ' +
          'attachments are re-validated (same-artist, READY track).',
        security: [{ bearerAuth: [] }],
        params: postIdParams,
        body: updatePostBody,
        response: { 200: artistPostSchema, ...communityErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'community.post_edit', config.rateLimits.communityPostEdit);
      const post = await updatePost(req.authUser!, req.params.postId, req.body, limits);
      return reply.code(200).send(post);
    },
  );

  app.delete<{ Params: { postId: string } }>(
    '/v1/community/posts/:postId',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'Delete your own post',
        description:
          'Author-only soft delete (DELETED). Admin moderation uses the ' +
          'admin moderate/restore endpoints instead. Idempotent.',
        security: [{ bearerAuth: [] }],
        params: postIdParams,
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
      await deletePost(req.authUser!, req.params.postId);
      return reply.code(204).send(null);
    },
  );

  // -------------------------------------------------------------- feed ---

  app.get(
    '/v1/community/feed',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: "Get the caller's followed-artist feed",
        description:
          'Authenticated. ACTIVE posts from artists the caller follows, ' +
          'newest first (publishedAt desc, post id tie-break). No ranking ' +
          'signals, no recommendations — chronological only. Standard ' +
          '?page= & ?limit= pagination.',
        security: [{ bearerAuth: [] }],
        querystring: communityListQuery,
        response: { 200: pageOf(artistPostSchema), 401: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as PaginationQuery;
      return reply.code(200).send(await getCommunityFeed(req.authUser!.id, query));
    },
  );

  // --------------------------------------------------- artist profile ---

  app.get<{ Params: { id: string } }>(
    '/v1/artists/:id/posts',
    {
      schema: {
        tags: ['Community'],
        summary: "List an artist's posts",
        description:
          'Public. ACTIVE posts only, newest first — the community ' +
          'extension of the public artist profile. No viewer state.',
        params: idParams,
        querystring: communityListQuery,
        response: { 200: pageOf(artistPostSchema), 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as PaginationQuery;
      return reply.code(200).send(await listArtistPosts(req.params.id, query));
    },
  );

  // ------------------------------------------------------------ comments ---

  app.get<{ Params: { postId: string } }>(
    '/v1/community/posts/:postId/comments',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'List comments on a post',
        description:
          'Authenticated. Flat list, ACTIVE comments only, oldest first. ' +
          'Standard ?page= & ?limit= pagination.',
        security: [{ bearerAuth: [] }],
        params: postIdParams,
        querystring: communityListQuery,
        response: { 200: pageOf(postCommentSchema), 401: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      const query = req.query as PaginationQuery;
      return reply.code(200).send(await listComments(req.authUser!, req.params.postId, query));
    },
  );

  app.post<{ Params: { postId: string }; Body: { body: string } }>(
    '/v1/community/posts/:postId/comments',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'Comment on a post',
        description:
          'Authenticated. Any signed-in user may comment on ACTIVE posts. ' +
          'Per-user rate limited.',
        security: [{ bearerAuth: [] }],
        params: postIdParams,
        body: createCommentBody,
        response: { 201: postCommentSchema, ...communityErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(
        req.authUser!.id,
        'community.comment_create',
        config.rateLimits.communityCommentCreate,
      );
      const comment = await createComment(req.authUser!, req.params.postId, req.body.body, limits);
      return reply.code(201).send(comment);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/community/comments/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'Delete your own comment',
        description:
          'Author-only soft delete (DELETED). Admin removal uses the ' +
          'admin moderate/restore endpoints. Idempotent.',
        security: [{ bearerAuth: [] }],
        params: idParams,
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
      await deleteComment(req.authUser!, req.params.id);
      return reply.code(204).send(null);
    },
  );

  // ------------------------------------------------------------ reactions ---

  app.post<{ Params: { postId: string } }>(
    '/v1/community/posts/:postId/reactions',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'React to a post',
        description:
          'Authenticated. Single reaction type; idempotent — reacting ' +
          'twice keeps exactly one reaction. Per-user rate limited.',
        security: [{ bearerAuth: [] }],
        params: postIdParams,
        response: { 200: reactionSchema, ...communityErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'community.reaction', config.rateLimits.communityReaction);
      return reply.code(200).send(await addReaction(req.authUser!, req.params.postId));
    },
  );

  app.delete<{ Params: { postId: string } }>(
    '/v1/community/posts/:postId/reactions',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'Remove your reaction',
        description: 'Authenticated. Idempotent — removing twice is safe.',
        security: [{ bearerAuth: [] }],
        params: postIdParams,
        response: { 200: reactionSchema, 401: problemSchema, 404: problemSchema },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await removeReaction(req.authUser!, req.params.postId));
    },
  );

  // ------------------------------------------------------- user reports ---

  app.post<{ Body: CreateModerationReportInput }>(
    '/v1/moderation-reports',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Community'],
        summary: 'Report a post or comment',
        description:
          'Authenticated. Files a report against an artist post or ' +
          'comment into the existing Phase 17 moderation workflow — the ' +
          'same queue admins review, the same audit trail. Per-user rate ' +
          'limited. Catalog targets (ARTIST/ALBUM/TRACK) stay admin-only.',
        security: [{ bearerAuth: [] }],
        body: createCommunityReportBody,
        response: { 201: moderationReportSchema, ...communityErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      userBucket(req.authUser!.id, 'community.report', config.rateLimits.communityReport);
      validateReportInput(req.body);
      const report = await createModerationReport(req.body, req.authUser!);
      return reply.code(201).send(report);
    },
  );

  // ---------------------------------------------------- admin actions ---

  const adminErrors = {
    400: problemSchema,
    401: problemSchema,
    403: problemSchema,
    404: problemSchema,
  };

  app.post<{ Params: { id: string } }>(
    '/v1/admin/community/posts/:id/moderate',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Remove an artist post (moderation)',
        description:
          'ADMIN-only. ACTIVE|DELETED -> REMOVED. Writes a ' +
          'community.post.removed audit row. Removed posts vanish from ' +
          'feeds, profiles, and search.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { 200: artistPostSchema, ...adminErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await moderatePost(req.authUser!, req.params.id));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/community/posts/:id/restore',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Restore a moderated post',
        description:
          'ADMIN-only. REMOVED|DELETED -> ACTIVE. Writes a ' +
          'community.post.restored audit row. Ordinary users can never ' +
          'restore content.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { 200: artistPostSchema, ...adminErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await restorePost(req.authUser!, req.params.id));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/community/comments/:id/moderate',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Remove a comment (moderation)',
        description:
          'ADMIN-only. ACTIVE|DELETED -> REMOVED. Writes a ' +
          'community.comment.removed audit row.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { 200: postCommentSchema, ...adminErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await moderateComment(req.authUser!, req.params.id));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/community/comments/:id/restore',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Restore a moderated comment',
        description:
          'ADMIN-only. REMOVED|DELETED -> ACTIVE. Writes a ' +
          'community.comment.restored audit row.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: { 200: postCommentSchema, ...adminErrors },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await restoreComment(req.authUser!, req.params.id));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/admin/community/posts/:id',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Review an artist post (any status)',
        description:
          'ADMIN-only. Returns the post regardless of moderation state, ' +
          'for the moderation review UI.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: {
          200: artistPostSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getPostForAdmin(req.params.id));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/admin/community/comments/:id',
    {
      preHandler: [app.authenticate, requireRole('ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Review a comment (any status)',
        description:
          'ADMIN-only. Returns the comment regardless of moderation ' +
          'state, for the moderation review UI.',
        security: [{ bearerAuth: [] }],
        params: idParams,
        response: {
          200: postCommentSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
      config: { rateLimit: limit },
    },
    async (req, reply) => {
      return reply.code(200).send(await getCommentForAdmin(req.params.id));
    },
  );
}
