// Phase 32 — request correlation. Every request gets a stable ID
// (client-supplied `x-request-id` is honored when it looks sane, otherwise
// a fresh UUID is minted). The ID is echoed back on the response and
// attached to every log line for the request, so a production incident can
// be traced from a client report to server logs with one value.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Accept client-supplied IDs only if they are plausible (no log injection). */
function sanitizeClientId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

export function resolveRequestId(req: FastifyRequest): string {
  const fromClient = sanitizeClientId(req.headers[REQUEST_ID_HEADER]);
  return fromClient ?? randomUUID();
}

export async function registerCorrelation(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    const requestId = resolveRequestId(req);
    (req as FastifyRequest & { requestId?: string }).requestId = requestId;
    reply.header(REQUEST_ID_HEADER, requestId);
  });

  // Attach the request ID to every log record for the request.
  app.addHook('preHandler', async (req) => {
    const requestId = (req as FastifyRequest & { requestId?: string }).requestId;
    if (requestId) {
      req.log = req.log.child({ requestId });
    }
  });
}

/** Convenience accessor for route handlers. */
export function requestIdOf(req: FastifyRequest): string | undefined {
  return (req as FastifyRequest & { requestId?: string }).requestId;
}
