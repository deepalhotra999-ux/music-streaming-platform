// Phase 25 — offline downloads. HTTP routes. Thin handlers over the
// offline service.
//
// Endpoints:
//   POST /v1/offline/downloads/authorize            (auth) mint a download grant
//   POST /v1/offline/downloads/:id/revalidate       (auth) revalidate a grant
//   POST /v1/offline/downloads/:id/revoke           (auth) revoke a grant
//   GET  /v1/offline/downloads/hls/master.m3u8       (?token=) download master
//   GET  /v1/offline/downloads/hls/:rendition/index.m3u8 (?token=) rendition
//   GET  /v1/offline/downloads/hls/:rendition/:segment   (?token=) segment + Range
//   POST /v1/playback/offline-events                (auth) upload queued events
//
// The API never serves audio from a permanent public URL: every manifest
// and segment response requires a valid, unexpired download token, and
// every served playlist has its asset URIs rewritten to token-scoped URLs.
// Download tokens are distinct from playback-session tokens.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PlayEventType } from '@prisma/client';
import type { Config } from '../../config.js';
import { prisma } from '../../db.js';
import { notFound, problemSchema } from '../../http/errors.js';
import { apiRateLimit, offlineAuthorizeRateLimit, streamingRateLimit } from '../../http/limits.js';
import {
  authorizeDownload,
  recordOfflineEvents,
  resolveDownloadToken,
  revalidateAuthorization,
  revokeAuthorization,
  type OfflineDeps,
  type OfflineEventInput,
} from './service.js';
import {
  createAudioStorage,
  mediaPlaylistKey,
  masterKey,
  segmentKey,
} from '../streaming/storage.js';
import { assertValidPlaylist, rewritePlaylistUris, sessionAssetUrl } from '../streaming/hls.js';
import { parseRange } from '../streaming/routes.js';
import {
  authorizeDownloadBody,
  authorizationIdParams,
  downloadAuthorizationSchema,
  downloadTokenQuery,
  offlineEventBody,
  offlineEventSyncSchema,
  revalidationSchema,
  revocationSchema,
} from './schemas.js';

const authErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
};

const deliveryErrors = {
  400: problemSchema,
  401: problemSchema,
  404: problemSchema,
  409: problemSchema,
  416: problemSchema,
};

interface TokenQuerystring {
  token: string;
}

async function readText(storage: OfflineDeps['storage'], key: string): Promise<string | null> {
  const obj = await storage.getObject(key);
  if (!obj) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of obj.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function offlineRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const apiLimit = apiRateLimit(config);
  const authorizeLimit = offlineAuthorizeRateLimit(config);
  const streamLimit = streamingRateLimit(config);
  const storage = await createAudioStorage(config);
  const deps: OfflineDeps = { db: prisma, config, storage };
  const basePath = '/v1/offline/downloads';

  // --- Download authorization ---------------------------------------------

  app.post<{ Body: { trackId: string } }>(
    '/v1/offline/downloads/authorize',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: authorizeLimit },
      schema: {
        body: authorizeDownloadBody,
        response: { 201: downloadAuthorizationSchema, ...authErrors },
      },
    },
    async (request, reply) => {
      const result = await authorizeDownload(request.authUser!.id, request.body.trackId, deps);
      return reply.code(201).send({
        authorizationId: result.authorizationId,
        token: result.token,
        downloadTokenExpiresAt: result.downloadTokenExpiresAt.toISOString(),
        expiresAt: result.expiresAt.toISOString(),
        audioVersion: result.audioVersion,
        track: result.track,
        downloadUrl: result.downloadUrl,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/offline/downloads/:id/revalidate',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: apiLimit },
      schema: {
        params: authorizationIdParams,
        response: { 200: revalidationSchema, ...authErrors },
      },
    },
    async (request, reply) => {
      const result = await revalidateAuthorization(request.params.id, request.authUser!.id, deps);
      return reply.send({
        valid: result.valid,
        status: result.status,
        expiresAt: result.expiresAt.toISOString(),
        audioVersion: result.audioVersion,
        currentAudioVersion: result.currentAudioVersion,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/offline/downloads/:id/revoke',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: apiLimit },
      schema: {
        params: authorizationIdParams,
        response: { 200: revocationSchema, ...authErrors },
      },
    },
    async (request, reply) => {
      const result = await revokeAuthorization(request.params.id, request.authUser!.id, prisma);
      return reply.send({ id: result.id, revokedAt: result.revokedAt.toISOString() });
    },
  );

  // --- HLS delivery (download token, no auth header needed) ----------------

  app.get<{ Querystring: TokenQuerystring }>(
    '/v1/offline/downloads/hls/master.m3u8',
    {
      config: { rateLimit: streamLimit },
      schema: { querystring: downloadTokenQuery, response: { 200: {}, ...deliveryErrors } },
    },
    async (request, reply) => {
      const grant = await resolveDownloadToken(request.query.token, deps);
      const stored = await readText(storage, masterKey(grant.trackId));
      if (stored === null) {
        throw notFound('Audio is not available for this track.');
      }
      assertValidPlaylist(stored);
      const rewritten = rewritePlaylistUris(stored, (uri) =>
        sessionAssetUrl(basePath, uri, request.query.token),
      );
      return reply
        .type('application/vnd.apple.mpegurl')
        .header('Cache-Control', 'no-store')
        .send(rewritten);
    },
  );

  app.get<{ Params: { rendition: string }; Querystring: TokenQuerystring }>(
    '/v1/offline/downloads/hls/:rendition/index.m3u8',
    {
      config: { rateLimit: streamLimit },
      schema: {
        params: {
          type: 'object',
          required: ['rendition'],
          additionalProperties: false,
          properties: {
            rendition: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[a-z0-9]+$' },
          },
        },
        querystring: downloadTokenQuery,
        response: { 200: {}, ...deliveryErrors },
      },
    },
    async (request, reply) => {
      const grant = await resolveDownloadToken(request.query.token, deps);
      const stored = await readText(
        storage,
        mediaPlaylistKey(grant.trackId, request.params.rendition),
      );
      if (stored === null) {
        throw notFound('Audio rendition is not available for this track.');
      }
      assertValidPlaylist(stored);
      const rewritten = rewritePlaylistUris(stored, (uri) =>
        sessionAssetUrl(basePath, `${request.params.rendition}/${uri}`, request.query.token),
      );
      return reply
        .type('application/vnd.apple.mpegurl')
        .header('Cache-Control', 'no-store')
        .send(rewritten);
    },
  );

  app.get<{ Params: { rendition: string; segment: string }; Querystring: TokenQuerystring }>(
    '/v1/offline/downloads/hls/:rendition/:segment',
    {
      config: { rateLimit: streamLimit },
      schema: {
        params: {
          type: 'object',
          required: ['rendition', 'segment'],
          additionalProperties: false,
          properties: {
            rendition: { type: 'string', minLength: 1, maxLength: 16, pattern: '^[a-z0-9]+$' },
            segment: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
              pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
            },
          },
        },
        querystring: downloadTokenQuery,
        response: { 200: {}, ...deliveryErrors },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { rendition: string; segment: string };
        Querystring: TokenQuerystring;
      }>,
      reply: FastifyReply,
    ) => {
      const grant = await resolveDownloadToken(request.query.token, deps);
      const key = segmentKey(grant.trackId, request.params.rendition, request.params.segment);
      const info = await storage.stat(key);
      if (!info) {
        throw notFound('Audio segment not found.');
      }

      const range = parseRange(request.headers.range, info.size);
      if (range === 'unsatisfiable') {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${info.size}`)
          .header('Accept-Ranges', 'bytes')
          .send();
      }

      const obj = await storage.getObject(key, range ?? undefined);
      if (!obj) {
        throw notFound('Audio segment not found.');
      }
      const headers: Record<string, string> = {
        'Content-Type': 'video/mp2t',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      };
      if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
        headers['Content-Length'] = String(range.end - range.start + 1);
        return reply.code(206).headers(headers).send(obj.stream);
      }
      headers['Content-Length'] = String(info.size);
      return reply.headers(headers).send(obj.stream);
    },
  );

  // --- Offline play-event sync ---------------------------------------------

  app.post<{
    Body: {
      events: {
        key: string;
        offlineAuthorizationId: string;
        offlineSessionKey: string;
        type: PlayEventType;
        positionMs?: number;
        occurredAt: string;
      }[];
    };
  }>(
    '/v1/playback/offline-events',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: apiLimit },
      schema: {
        body: offlineEventBody,
        response: { 202: offlineEventSyncSchema, ...authErrors },
      },
    },
    async (request, reply) => {
      const inputs: OfflineEventInput[] = request.body.events.map((e) => ({
        key: e.key,
        offlineAuthorizationId: e.offlineAuthorizationId,
        offlineSessionKey: e.offlineSessionKey,
        type: e.type,
        positionMs: e.positionMs,
        occurredAt: e.occurredAt,
      }));
      const result = await recordOfflineEvents(request.authUser!.id, inputs, deps);
      return reply.code(202).send(result);
    },
  );
}
