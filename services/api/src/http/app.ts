// Phase 4 — backend API. Fastify application assembly.
// buildApp() is exported (rather than only a listening server) so tests can
// exercise the full HTTP stack via `app.inject()` without opening a port.

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { Config } from '../config.js';
import { registerErrorHandler } from './errors.js';
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
import { ingestionRoutes } from '../modules/ingestion/routes.js';
import { analyticsRoutes } from '../modules/analytics/routes.js';
import { auditRoutes } from '../modules/audit/routes.js';
import { moderationRoutes } from '../modules/moderation/routes.js';
import { subscriptionRoutes } from '../modules/subscriptions/routes.js';
import { royaltyArtistRoutes, royaltyAdminRoutes } from '../modules/royalties/index.js';

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

  app.get('/v1/health', async () => ({ status: 'ok' }));

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
    await ingestionRoutes(instance, config);
    await analyticsRoutes(instance, config);
    await auditRoutes(instance, config);
    await moderationRoutes(instance, config);
    await subscriptionRoutes(instance, config);
    await royaltyArtistRoutes(instance, config);
    await royaltyAdminRoutes(instance, config);
  });

  return app;
}
