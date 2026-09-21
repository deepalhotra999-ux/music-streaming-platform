// Phase 3 — authentication. Fastify application assembly.
// buildApp() is exported (rather than only a listening server) so tests can
// exercise the full HTTP stack via `app.inject()` without opening a port.

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '../config.js';
import { registerErrorHandler } from './errors.js';
import { authPlugin } from './auth.js';
import { authRoutes } from '../modules/auth/routes.js';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : {
            level: config.nodeEnv === 'production' ? 'info' : 'debug',
            // Structured JSON logs (Phase 1 observability baseline).
            formatters: { level: (label) => ({ level: label }) },
          },
  });

  // Per-route limits only; no global limit (see ADR-002 consequences).
  await app.register(rateLimit, { global: false });

  registerErrorHandler(app);
  await authPlugin(app, config);

  app.get('/v1/health', async () => ({ status: 'ok' }));

  await app.register(async (instance) => {
    await authRoutes(instance, config);
  });

  return app;
}
