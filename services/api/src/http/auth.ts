// Phase 3 — authentication. Verifies Bearer access JWTs and exposes the
// `app.authenticate` preHandler guard plus `request.authUser`.
// Registered on the root instance so all route modules inherit it.
//
// Admin V2 — impersonation: a short-lived JWT with `imp: true` lets a
// SUPER_ADMIN act as a non-admin user. The token is validated on every
// request (actor must still be SUPER_ADMIN; target must still be an active
// non-admin), and impersonated sessions are hard-blocked from /v1/admin/*.
// Admin V2 — emergency enforcement: maintenance mode (503 for non-admins)
// and read-only mode (403 on mutations for non-admins) are enforced here,
// after identity is resolved.

import * as jose from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { forbidden, serviceUnavailable, unauthorized } from './errors.js';
import { prisma } from '../db.js';
import { isAdminRole } from './authorization.js';
import { emergencyActive, getMaintenanceMessage } from '../modules/ops/settings.js';

export interface ImpersonationContext {
  adminId: string;
  reason: string;
  startedAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  /** Present when this request acts under an impersonation session. */
  impersonation?: ImpersonationContext;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `authenticate` guard; null on unauthenticated requests. */
    authUser: AuthUser | null;
  }
  interface FastifyInstance {
    /** preHandler: rejects with 401 unless a valid Bearer token is present. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * preHandler: populates `request.authUser` when a valid Bearer token is
     * present, but never rejects. For endpoints with mixed visibility (e.g.
     * public playlists), where the service decides based on who is asking.
     */
    authenticateOptional: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const ADMIN_BLOCKED_IMPERSONATION = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'PLATFORM_ADMIN',
  'MODERATOR',
  'SUPPORT_ADMIN',
  'FINANCE_ADMIN',
  'CONTENT_ADMIN',
  'ARTIST_ADMIN',
  'ANALYTICS_ADMIN',
]);

/**
 * Resolve an impersonation JWT into the target user's identity. Every check
 * is re-done on every request: the actor must still be an active
 * SUPER_ADMIN, and the target must still be an active, non-banned,
 * non-admin user. Any failure is a 401 — fail closed.
 */
async function resolveImpersonation(payload: jose.JWTPayload): Promise<AuthUser> {
  const actorId = payload.actorId;
  const reason = payload.reason;
  const startedAt = payload.impStartedAt;
  const targetId = payload.sub;
  if (
    typeof actorId !== 'string' ||
    typeof reason !== 'string' ||
    typeof startedAt !== 'string' ||
    typeof targetId !== 'string'
  ) {
    throw unauthorized('Invalid or expired access token.');
  }
  const [actorRow, targetRow] = await Promise.all([
    prisma.user.findUnique({ where: { id: actorId }, select: { role: true, deletedAt: true } }),
    prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, email: true, role: true, deletedAt: true, bannedAt: true },
    }),
  ]);
  if (!actorRow || actorRow.deletedAt || actorRow.role !== 'SUPER_ADMIN') {
    throw unauthorized('Invalid or expired access token.');
  }
  if (
    !targetRow ||
    targetRow.deletedAt ||
    targetRow.bannedAt ||
    ADMIN_BLOCKED_IMPERSONATION.has(targetRow.role)
  ) {
    throw unauthorized('Invalid or expired access token.');
  }
  return {
    id: targetRow.id,
    email: targetRow.email,
    role: targetRow.role,
    impersonation: { adminId: actorId, reason, startedAt },
  };
}

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Admin V2 emergency enforcement, applied after identity is resolved:
 * - maintenance mode → 503 for everyone except admin-tier callers on admin
 *   routes (admins must be able to recover the platform);
 * - read-only mode → 403 on mutations for non-admin callers.
 */
async function enforceEmergency(req: FastifyRequest, user: AuthUser): Promise<void> {
  const admin = isAdminRole(user.role);
  const onAdminRoute = req.url.startsWith('/v1/admin');
  if (!admin || !onAdminRoute) {
    if (await emergencyActive('emergency.maintenance_mode')) {
      throw serviceUnavailable(await getMaintenanceMessage());
    }
  }
  if (!admin && MUTATION_METHODS.has(req.method)) {
    if (await emergencyActive('emergency.readonly_mode')) {
      throw forbidden('The platform is in read-only mode. Changes are temporarily disabled.');
    }
  }
  if (user.impersonation && onAdminRoute) {
    // Defense in depth: impersonated sessions must never reach admin routes,
    // even if a route forgets its own guard. The single exception is the
    // explicit exit route — an impersonated caller must be able to end the
    // session and discard the token.
    if (req.url !== '/v1/admin/impersonation/end' && !req.url.startsWith('/v1/admin/impersonation/end?')) {
      throw forbidden('Impersonated sessions cannot access admin routes.');
    }
  }
}

async function verifyToken(token: string, config: Config): Promise<jose.JWTPayload> {
  const secret = new TextEncoder().encode(config.jwtSecret);
  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
    return payload;
  } catch {
    // Deliberately vague: expired, tampered, and wrong-audience tokens all
    // look the same from the outside.
    throw unauthorized('Invalid or expired access token.');
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export async function authPlugin(app: FastifyInstance, config: Config): Promise<void> {
  app.decorateRequest('authUser', null);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const token = extractBearer(req);
    if (!token) {
      throw unauthorized('Missing or malformed Authorization header. Use "Bearer <token>".');
    }
    const payload = await verifyToken(token, config);
    let user: AuthUser;
    if (payload.imp === true) {
      user = await resolveImpersonation(payload);
    } else {
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
        throw unauthorized('Invalid or expired access token.');
      }
      user = {
        id: payload.sub,
        email: payload.email,
        role: typeof payload.role === 'string' ? payload.role : 'LISTENER',
      };
    }
    await enforceEmergency(req, user);
    req.authUser = user;
  });

  app.decorate('authenticateOptional', async (req: FastifyRequest) => {
    const token = extractBearer(req);
    if (!token) return;
    let payload: jose.JWTPayload;
    try {
      payload = await verifyToken(token, config);
    } catch {
      // Optional auth: an invalid token is treated the same as no token.
      // Routes that require auth use the strict `authenticate` guard instead.
      return;
    }
    let user: AuthUser;
    try {
      if (payload.imp === true) {
        user = await resolveImpersonation(payload);
      } else {
        if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return;
        user = {
          id: payload.sub,
          email: payload.email,
          role: typeof payload.role === 'string' ? payload.role : 'LISTENER',
        };
      }
      // Maintenance mode still applies to authenticated-optional reads.
      if (!isAdminRole(user.role) && (await emergencyActive('emergency.maintenance_mode'))) {
        throw serviceUnavailable(await getMaintenanceMessage());
      }
      if (user.impersonation && req.url.startsWith('/v1/admin')) {
        if (req.url !== '/v1/admin/impersonation/end' && !req.url.startsWith('/v1/admin/impersonation/end?')) {
          throw forbidden('Impersonated sessions cannot access admin routes.');
        }
      }
    } catch {
      // Fail closed: an impersonation token that no longer validates is
      // treated as no token on optional-auth routes.
      return;
    }
    req.authUser = user;
  });
}
