// Phase 3 — authentication. HTTP routes. Thin handlers: validate (via
// schema), call the service, map domain errors to RFC 7807 problems.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { prisma } from '../../db.js';
import { conflict, unauthorized } from '../../http/errors.js';
import {
  authResultSchema,
  loginBody,
  logoutBody,
  publicUserSchema,
  refreshBody,
  registerBody,
} from './schemas.js';
import {
  DuplicateEmailError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  login,
  logout,
  refresh,
  register,
} from './service.js';

interface RegisterBody {
  email: string;
  password: string;
  displayName: string;
}
interface LoginBody {
  email: string;
  password: string;
}
interface TokenBody {
  refreshToken: string;
}

export async function authRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const limits = config.rateLimits;

  app.post<{ Body: RegisterBody }>(
    '/v1/auth/register',
    {
      schema: { body: registerBody, response: { 201: authResultSchema } },
      config: { rateLimit: { max: limits.register, timeWindow: limits.windowMs } },
    },
    async (req, reply) => {
      try {
        const result = await register(req.body, config);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof DuplicateEmailError) throw conflict(err.message);
        throw err;
      }
    },
  );

  app.post<{ Body: LoginBody }>(
    '/v1/auth/login',
    {
      schema: { body: loginBody, response: { 200: authResultSchema } },
      config: { rateLimit: { max: limits.login, timeWindow: limits.windowMs } },
    },
    async (req, reply) => {
      try {
        const result = await login(req.body, config);
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InvalidCredentialsError) throw unauthorized(err.message);
        throw err;
      }
    },
  );

  app.post<{ Body: TokenBody }>(
    '/v1/auth/refresh',
    {
      schema: { body: refreshBody, response: { 200: authResultSchema } },
      config: { rateLimit: { max: limits.refresh, timeWindow: limits.windowMs } },
    },
    async (req, reply) => {
      try {
        const result = await refresh(req.body.refreshToken, config);
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof InvalidRefreshTokenError) throw unauthorized(err.message);
        throw err;
      }
    },
  );

  app.post<{ Body: TokenBody }>(
    '/v1/auth/logout',
    {
      schema: { body: logoutBody },
      config: { rateLimit: { max: limits.logout, timeWindow: limits.windowMs } },
    },
    async (req, reply) => {
      await logout(req.body.refreshToken);
      return reply.code(204).send();
    },
  );

  app.get(
    '/v1/me',
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: publicUserSchema } },
    },
    async (req, reply) => {
      // The guard guarantees authUser; the service re-reads the row so a
      // deleted account stops working even with a not-yet-expired JWT.
      const user = await prisma.user.findUnique({ where: { id: req.authUser!.id } });
      if (!user || user.deletedAt) {
        throw unauthorized('Account no longer exists.');
      }
      return reply.code(200).send({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        role: user.role,
        emailVerified: user.emailVerified,
        countryCode: user.countryCode,
        createdAt: user.createdAt,
      });
    },
  );
}
