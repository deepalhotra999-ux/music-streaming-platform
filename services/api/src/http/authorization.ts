// Phase 4 — authorization helpers. Authentication ("who are you?") is the
// `app.authenticate` guard from http/auth.ts; this module answers "may you?"
// Run role checks AFTER `app.authenticate` in the preHandler chain so
// `request.authUser` is populated.

import type { FastifyRequest } from 'fastify';
import { forbidden } from './errors.js';
import type { AuthUser } from './auth.js';

export type Role = 'LISTENER' | 'ARTIST' | 'ADMIN';

export const isAdmin = (user: AuthUser | null | undefined): boolean => user?.role === 'ADMIN';

/**
 * preHandler factory: rejects with 403 unless the caller's role is one of the
 * allowed roles. Combine with `app.authenticate`, e.g.:
 *   preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')]
 */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    const user = req.authUser;
    if (!user || !roles.includes(user.role as Role)) {
      throw forbidden(`This action requires one of the following roles: ${roles.join(', ')}.`);
    }
  };
}

/** True when the caller owns the artist row or is an admin. */
export function canManageArtist(user: AuthUser, artist: { ownerUserId: string | null }): boolean {
  return isAdmin(user) || artist.ownerUserId === user.id;
}
