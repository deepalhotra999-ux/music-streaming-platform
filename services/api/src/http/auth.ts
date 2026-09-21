// Phase 3 — authentication. Verifies Bearer access JWTs and exposes the
// `app.authenticate` preHandler guard plus `request.authUser`.
// Registered on the root instance so all route modules inherit it.

import * as jose from 'jose';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { unauthorized } from './errors.js';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
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

export async function authPlugin(app: FastifyInstance, config: Config): Promise<void> {
  const secret = new TextEncoder().encode(config.jwtSecret);

  app.decorateRequest('authUser', null);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw unauthorized('Missing or malformed Authorization header. Use "Bearer <token>".');
    }
    const token = header.slice(7).trim();
    if (!token) {
      throw unauthorized('Missing or malformed Authorization header. Use "Bearer <token>".');
    }

    let payload: jose.JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, secret, {
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      }));
    } catch {
      // Deliberately vague: expired, tampered, and wrong-audience tokens all
      // look the same from the outside.
      throw unauthorized('Invalid or expired access token.');
    }

    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw unauthorized('Invalid or expired access token.');
    }
    req.authUser = {
      id: payload.sub,
      email: payload.email,
      role: typeof payload.role === 'string' ? payload.role : 'LISTENER',
    };
  });

  app.decorate('authenticateOptional', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) return;
    const token = header.slice(7).trim();
    if (!token) return;

    let payload: jose.JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(token, secret, {
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      }));
    } catch {
      // Optional auth: an invalid token is treated the same as no token.
      // Routes that require auth use the strict `authenticate` guard instead.
      return;
    }

    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return;
    req.authUser = {
      id: payload.sub,
      email: payload.email,
      role: typeof payload.role === 'string' ? payload.role : 'LISTENER',
    };
  });
}
