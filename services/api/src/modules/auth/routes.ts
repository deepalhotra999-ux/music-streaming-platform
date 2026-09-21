// Phase 3 — authentication. HTTP routes. Thin handlers: validate (via
// schema), call the service, map domain errors to RFC 7807 problems.

import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { prisma } from '../../db.js';
import { conflict, problemSchema, unauthorized } from '../../http/errors.js';
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
      schema: {
        tags: ['Auth'],
        summary: 'Register a new account',
        description: 'Creates a LISTENER account and returns tokens. Email must be unique.',
        body: registerBody,
        response: { 201: authResultSchema, 400: problemSchema, 409: problemSchema },
      },
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
      schema: {
        tags: ['Auth'],
        summary: 'Log in',
        description: 'Verifies credentials and returns a fresh token pair.',
        body: loginBody,
        response: { 200: authResultSchema, 400: problemSchema, 401: problemSchema },
      },
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
      schema: {
        tags: ['Auth'],
        summary: 'Refresh tokens',
        description: 'Rotates a refresh token; reuse revokes the whole token family.',
        body: refreshBody,
        response: { 200: authResultSchema, 400: problemSchema, 401: problemSchema },
      },
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
      schema: {
        tags: ['Auth'],
        summary: 'Log out',
        description: 'Revokes a refresh token.',
        body: logoutBody,
        response: { 204: { type: 'null' }, 400: problemSchema },
      },
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
      schema: {
        tags: ['Auth'],
        summary: 'Get my account',
        description: 'Returns the authenticated user’s own profile.',
        security: [{ bearerAuth: [] }],
        response: { 200: publicUserSchema, 401: problemSchema },
      },
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
