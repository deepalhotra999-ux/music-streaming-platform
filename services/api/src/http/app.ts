// Phase 4 — backend API. Fastify application assembly.
// buildApp() is exported (rather than only a listening server) so tests can
// exercise the full HTTP stack via `app.inject()` without opening a port.

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import type { Config } from '../config.js';
import { registerErrorHandler } from './errors.js';
import { registerCorrelation } from './correlation.js';
import { metrics } from './metrics.js';
import { authPlugin } from './auth.js';
import { authRoutes } from '../modules/auth/routes.js';
import { usersRoutes } from '../modules/users/routes.js';
import { artistsRoutes } from '../modules/artists/routes.js';
import { albumsRoutes } from '../modules/albums/routes.js';
import { tracksRoutes } from '../modules/tracks/routes.js';
import { genresRoutes } from '../modules/genres/routes.js';
import { playlistsRoutes } from '../modules/playlists/routes.js';
import { likesRoutes } from '../modules/likes/routes.js';
import { followsRoutes } from '../modules/follows/routes.js';
import { historyRoutes } from '../modules/history/routes.js';
import { streamingRoutes } from '../modules/streaming/routes.js';
import { offlineRoutes } from '../modules/offline/routes.js';
import { discoveryRoutes } from '../modules/discovery/routes.js';
import { ingestionRoutes } from '../modules/ingestion/routes.js';
import { analyticsRoutes } from '../modules/analytics/routes.js';
import { auditRoutes } from '../modules/audit/routes.js';
import { governanceRoutes } from '../modules/governance/routes.js';
import { opsRoutes } from '../modules/ops/routes.js';
import { releaseRoutes } from '../modules/releases/routes.js';
import { moderationRoutes } from '../modules/moderation/routes.js';
import { communityRoutes } from '../modules/community/routes.js';
import { commerceRoutes } from '../modules/commerce/routes.js';
import { subscriptionRoutes } from '../modules/subscriptions/routes.js';
import { billingRoutes } from '../modules/subscriptions/billingRoutes.js';
import { royaltyArtistRoutes, royaltyAdminRoutes } from '../modules/royalties/index.js';
import { roomsRoutes } from '../modules/rooms/routes.js';
import { roomsGateway } from '../modules/rooms/gateway.js';

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
    // Phase 32 — bound JSON bodies globally (uploads use multipart with
    // their own streaming limit). trustProxy is explicit: enable only
    // behind a reverse proxy (ALB/CloudFront) so req.ip is the real client.
    bodyLimit: config.http.bodyLimitBytes,
    trustProxy: config.http.trustProxy,
  });

  // Phase 32 — security headers. Swagger UI needs inline scripts/styles,
  // so CSP is relaxed to what the docs page requires; the API itself
  // returns JSON and never executes browser scripts.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });

  // Phase 32 — CORS is deny-by-default. Browsers cannot call the API
  // cross-origin unless CORS_ORIGIN names the admin console origin(s).
  // Mobile apps are not browsers and do not need CORS.
  if (config.http.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.http.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
      exposedHeaders: ['x-request-id'],
      maxAge: 86400,
    });
  }

  // Phase 32 — request correlation (x-request-id in/out, attached to logs).
  await registerCorrelation(app);

  // Phase 32 — observability: count requests by status class and note
  // auth failures / rate-limit hits for the metrics snapshot.
  app.addHook('onResponse', async (req, reply) => {
    metrics.recordRequest(reply.statusCode);
    if (reply.statusCode === 401 || reply.statusCode === 403) metrics.recordAuthFailure();
    if (reply.statusCode === 429) metrics.recordRateLimitHit();
  });

  // Per-route limits only; no global limit (see ADR-002 consequences).
  await app.register(rateLimit, { global: false });

  // Phase 28 — WebSocket transport for synchronized listening rooms.
  // Bound the inbound frame size; room messages are small JSON payloads.
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // OpenAPI 3.0 document, generated from the route schemas below.
  // Register before the routes so every route is captured. The import also
  // augments Fastify's schema types (tags/summary/security), which the
  // Phase 4 route modules rely on.
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Music Streaming API',
        description:
          'Phase 4 backend API: users, artists, albums, tracks, genres, ' +
          'playlists, likes, follows, and listening history.',
        version: '4.0.0',
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
      tags: [
        { name: 'Auth', description: 'Registration, login, and token management' },
        { name: 'Users', description: 'User accounts and roles' },
        { name: 'Artists', description: 'Artists and their public profiles' },
        { name: 'Albums', description: 'Albums and singles' },
        { name: 'Tracks', description: 'Individual tracks' },
        { name: 'Genres', description: 'Genre taxonomy (admin-managed)' },
        { name: 'Playlists', description: 'Playlists and playlist items' },
        { name: 'Likes', description: "The caller's liked tracks" },
        { name: 'Follows', description: "The caller's followed artists" },
        { name: 'History', description: "The caller's listening history" },
        { name: 'Admin', description: 'Admin-only audit log (append-only)' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Access JWT from POST /v1/auth/login.',
          },
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  registerErrorHandler(app);
  await authPlugin(app, config);

  // Admin routes, health, docs, and the login/refresh endpoints admins need
  // to sign in stay reachable; everything else is 503 while maintenance mode
  // is active.
  app.addHook('onRequest', async (req, reply) => {
    const allowed =
      req.url === '/v1/health' ||
      req.url === '/v1/ready' ||
      req.url === '/v1/metrics' ||
      req.url === '/openapi.json' ||
      req.url.startsWith('/docs') ||
      req.url.startsWith('/v1/admin') ||
      req.url.startsWith('/v1/auth/login') ||
      req.url.startsWith('/v1/auth/refresh');
    if (allowed) return;
    try {
      const { emergencyActive, getMaintenanceMessage } = await import('../modules/ops/settings.js');
      if (await emergencyActive('emergency.maintenance_mode')) {
        reply.code(503).send({
          status: 503,
          title: 'Service Unavailable',
          detail: await getMaintenanceMessage(),
        });
      }
    } catch {
      // Fail open here: an unreachable settings cache must not take the
      // platform down by itself. Authenticated enforcement (fail-closed)
      // still applies inside the auth guards.
    }
  });

  app.get('/v1/health', async () => ({ status: 'ok' }));

  // Phase 32 — readiness: liveness is "the process answers"; readiness is
  // "the process can serve traffic" (DB reachable). Load balancers and
  // orchestrators must use /v1/ready.
  app.get('/v1/ready', async (_req, reply) => {
    try {
      const { prisma } = await import('../db.js');
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      reply.code(503);
      return { status: 'not_ready', reason: 'database unreachable' };
    }
  });

  // Phase 32 — observability snapshot. Gated: only reachable from loopback
  // or with ADMIN credentials (defense in depth — counters contain no PII
  // but traffic shape is still operationally sensitive).
  app.get('/v1/metrics', { preHandler: app.authenticateOptional }, async (req, reply) => {
    const ip = req.ip;
    const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!loopback && req.authUser?.role !== 'ADMIN') {
      reply.code(404);
      return { status: 404, title: 'Not Found' };
    }
    return metrics.snapshot();
  });

  await app.register(async (instance) => {
    await authRoutes(instance, config);
    await usersRoutes(instance, config);
    await artistsRoutes(instance, config);
    await albumsRoutes(instance, config);
    await tracksRoutes(instance, config);
    await genresRoutes(instance, config);
    await playlistsRoutes(instance, config);
    await likesRoutes(instance, config);
    await followsRoutes(instance, config);
    await historyRoutes(instance, config);
    await streamingRoutes(instance, config);
    await offlineRoutes(instance, config);
    await discoveryRoutes(instance, config);
    await ingestionRoutes(instance, config);
    await analyticsRoutes(instance, config);
    await auditRoutes(instance, config);
    await governanceRoutes(instance, config);
    await opsRoutes(instance, config);
    await releaseRoutes(instance, config);
    await moderationRoutes(instance, config);
    await communityRoutes(instance, config);
    await commerceRoutes(instance, config);
    await subscriptionRoutes(instance, config);
    await billingRoutes(instance);
    await royaltyArtistRoutes(instance, config);
    await royaltyAdminRoutes(instance, config);
    await roomsRoutes(instance, config);
    await roomsGateway(instance, config);
  });

  return app;
}
