// Release tooling — admin deploy surface. HTTP routes; thin handlers over
// the releases service.
//
// POST /v1/admin/deploy      — ADMIN-only. Fires a GitHub repository_dispatch
//                              ("deploy-requested") so the CD workflow runs
//                              for the given ref. Audited as deploy.triggered.
// GET  /v1/admin/deploy/runs — ADMIN-only. Recent workflow runs (newest
//                              first), for the admin Releases page.
//
// Neither endpoint executes code on this server. When GITHUB_DEPLOY_TOKEN is
// unset both fail closed with 503 and a setup hint.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { problemSchema } from '../../http/errors.js';
import { serviceUnavailable } from '../../http/errors.js';
import { requireRole } from '../../http/authorization.js';
import { deployRateLimit, apiRateLimit } from '../../http/limits.js';
import { recordAuditEvent } from '../audit/service.js';
import {
  DEPLOY_EVENT_TYPE,
  DeployNotConfiguredError,
  listDeployRuns,
  triggerDeploy,
  type GitHubDeployConfig,
} from './service.js';
import {
  deployBodySchema,
  deployResponseSchema,
  deployRunsResponseSchema,
} from './schemas.js';

const NOT_CONFIGURED_DETAIL =
  'Deployments are not configured. Set GITHUB_DEPLOY_TOKEN (a fine-grained ' +
  'personal access token with Actions: write on the repo) in the API ' +
  'environment, then retry. See docs/RELEASES.md.';

function githubConfig(config: Config): GitHubDeployConfig {
  return { token: config.releases.deployToken, repo: config.releases.deployRepo };
}

export async function releaseRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const deployLimit = deployRateLimit(config);
  const readLimit = apiRateLimit(config);

  app.post(
    '/v1/admin/deploy',
    {
      preHandler: [app.authenticate, requireRole('ADMIN', 'SUPER_ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'Trigger a deployment',
        description:
          'Admin-only. Fires a "deploy-requested" repository_dispatch event ' +
          'to GitHub Actions, which builds, verifies, and deploys `ref` ' +
          '(default "main"). This endpoint never executes code itself; it ' +
          'only dispatches. The action is audit-logged. Fails closed with ' +
          '503 when GITHUB_DEPLOY_TOKEN is not configured.',
        security: [{ bearerAuth: [] }],
        body: deployBodySchema,
        response: {
          202: deployResponseSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          503: problemSchema,
        },
      },
      config: { rateLimit: deployLimit },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { ref?: string };
      const ref = body.ref ?? 'main';
      try {
        const result = await triggerDeploy(ref, githubConfig(config));
        // Audit after a successful dispatch. Facts only: ref + event type.
        // The token is never written here.
        await recordAuditEvent({
          actorId: req.authUser?.id ?? null,
          action: 'deploy.triggered',
          targetType: 'deployment',
          metadata: { ref, eventType: DEPLOY_EVENT_TYPE },
        });
        return reply.code(202).send({ dispatched: true, ...result });
      } catch (err) {
        if (err instanceof DeployNotConfiguredError) {
          throw serviceUnavailable(NOT_CONFIGURED_DETAIL);
        }
        throw err;
      }
    },
  );

  app.get(
    '/v1/admin/deploy/runs',
    {
      preHandler: [app.authenticate, requireRole('ADMIN', 'SUPER_ADMIN')],
      schema: {
        tags: ['Admin'],
        summary: 'List recent deployment workflow runs',
        description:
          'Admin-only. The 20 most recent GitHub Actions workflow runs for ' +
          'the repo, newest first. Backs the admin Releases page. Fails ' +
          'closed with 503 when GITHUB_DEPLOY_TOKEN is not configured.',
        security: [{ bearerAuth: [] }],
        response: {
          200: deployRunsResponseSchema,
          401: problemSchema,
          403: problemSchema,
          503: problemSchema,
        },
      },
      config: { rateLimit: readLimit },
    },
    async (req, reply) => {
      try {
        const data = await listDeployRuns(githubConfig(config));
        return reply.code(200).send({ data });
      } catch (err) {
        if (err instanceof DeployNotConfiguredError) {
          throw serviceUnavailable(NOT_CONFIGURED_DETAIL);
        }
        throw err;
      }
    },
  );
}
