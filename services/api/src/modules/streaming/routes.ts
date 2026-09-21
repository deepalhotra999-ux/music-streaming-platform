// Phase 7 — streaming. HTTP routes. Thin handlers over the streaming service.
//
// Endpoints:
//   POST /v1/playback/sessions              (auth) create a playback session
//   GET  /v1/playback/hls/master.m3u8       (?token=) session master playlist
//   GET  /v1/playback/hls/:rendition/index.m3u8 (?token=) media playlist
//   GET  /v1/playback/hls/:rendition/:segment   (?token=) segment bytes + Range
//   POST /v1/playback/sessions/:id/events   (auth) record a play event
//
// The API never serves audio from a permanent public URL: every manifest and
// segment response requires a valid, unexpired session token, and every served
// playlist has its asset URIs rewritten to session-scoped URLs.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PlayEventType } from '@prisma/client';
import type { Config } from '../../config.js';
import { prisma } from '../../db.js';
import { notFound, problemSchema } from '../../http/errors.js';
import { apiRateLimit, streamingRateLimit } from '../../http/limits.js';
import {
  createPlaybackSession,
  getSessionForEvents,
  recordPlayEvent,
  resolvePlaybackSession,
  type StreamingDeps,
} from './service.js';
import { createAudioStorage, mediaPlaylistKey, masterKey, segmentKey } from './storage.js';
import { assertValidPlaylist, rewritePlaylistUris, sessionAssetUrl } from './hls.js';
import {
  createSessionBody,
  playEventBody,
  playEventSchema,
  renditionParams,
  segmentParams,
  sessionIdParams,
  sessionSchema,
  sessionTokenQuery,
} from './schemas.js';

const sessionErrors = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
};

const streamErrors = {
  400: problemSchema,
  401: problemSchema,
  404: problemSchema,
  409: problemSchema,
  416: problemSchema,
};

interface TokenQuerystring {
  token: string;
}

/** Parse a Range header. Null = no range requested; 'unsatisfiable' = 416. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'unsatisfiable';
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return 'unsatisfiable';
  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: last N bytes.
    const suffix = Number(endStr);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isSafeInteger(start) || start < 0) return 'unsatisfiable';
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isSafeInteger(end) || end < 0) return 'unsatisfiable';
  }
  if (start >= size || end >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

async function readText(storage: StreamingDeps['storage'], key: string): Promise<string | null> {
  const obj = await storage.getObject(key);
  if (!obj) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of obj.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function streamingRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const apiLimit = apiRateLimit(config);
  const streamLimit = streamingRateLimit(config);
  // One storage handle per app instance; the driver is chosen at startup.
  const storage = createAudioStorage(config);
  const deps: StreamingDeps = { db: prisma, config, storage };
  const basePath = '/v1/playback';

  // --- Playback sessions -------------------------------------------------

  app.post<{ Body: { trackId: string } }>(
    '/v1/playback/sessions',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: apiLimit },
      schema: {
        body: createSessionBody,
        response: { 201: sessionSchema, ...sessionErrors },
      },
    },
    async (request, reply) => {
      const result = await createPlaybackSession(request.authUser!.id, request.body.trackId, deps);
      return reply.code(201).send({
        id: result.id,
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        hlsUrl: result.hlsUrl,
      });
    },
  );

  // --- HLS delivery (session token, no auth header needed) ----------------

  app.get<{ Querystring: TokenQuerystring }>(
    '/v1/playback/hls/master.m3u8',
    {
      config: { rateLimit: streamLimit },
      schema: { querystring: sessionTokenQuery, response: { 200: {}, ...streamErrors } },
    },
    async (request, reply) => {
      const session = await resolvePlaybackSession(request.query.token, deps);
      const stored = await readText(storage, masterKey(session.trackId));
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
    '/v1/playback/hls/:rendition/index.m3u8',
    {
      config: { rateLimit: streamLimit },
      schema: {
        params: renditionParams,
        querystring: sessionTokenQuery,
        response: { 200: {}, ...streamErrors },
      },
    },
    async (request, reply) => {
      const session = await resolvePlaybackSession(request.query.token, deps);
      const stored = await readText(
        storage,
        mediaPlaylistKey(session.trackId, request.params.rendition),
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
    '/v1/playback/hls/:rendition/:segment',
    {
      config: { rateLimit: streamLimit },
      schema: {
        params: segmentParams,
        querystring: sessionTokenQuery,
        response: { 200: {}, ...streamErrors },
      },
    },
    async (request: FastifyRequest<{ Params: { rendition: string; segment: string }; Querystring: TokenQuerystring }>, reply: FastifyReply) => {
      const session = await resolvePlaybackSession(request.query.token, deps);
      const key = segmentKey(session.trackId, request.params.rendition, request.params.segment);
      const info = await storage.stat(key);
      if (!info) {
        throw notFound('Audio segment not found.');
      }

      const range = parseRange(request.headers.range, info.size);
      if (range === 'unsatisfiable') {
        return reply
          .code(416)
          .type('application/problem+json')
          .header('Content-Range', `bytes */${info.size}`)
          .send({
            type: 'https://api.music-streaming.local/problems/range-unsatisfiable',
            title: 'Range Not Satisfiable',
            status: 416,
            detail: 'The requested byte range cannot be satisfied.',
          });
      }

      const obj = await storage.getObject(
        key,
        range === null ? undefined : { start: range.start, end: range.end },
      );
      if (!obj) {
        throw notFound('Audio segment not found.');
      }

      reply
        .type(obj.contentType)
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'public, max-age=31536000, immutable');

      if (range === null) {
        reply.header('Content-Length', obj.size);
        return reply.send(obj.stream);
      }
      const length = range.end - range.start + 1;
      reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${obj.size}`)
        .header('Content-Length', length);
      return reply.send(obj.stream);
    },
  );

  // --- Play events ---------------------------------------------------------

  app.post<{
    Params: { id: string };
    Body: { type: PlayEventType; positionMs?: number };
  }>(
    '/v1/playback/sessions/:id/events',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: apiLimit },
      schema: {
        params: sessionIdParams,
        body: playEventBody,
        response: { 201: playEventSchema, ...sessionErrors },
      },
    },
    async (request, reply) => {
      const session = await getSessionForEvents(request.params.id, request.authUser!.id);
      const event = await recordPlayEvent({
        sessionId: session.sessionId,
        userId: session.userId,
        trackId: session.trackId,
        eventType: request.body.type,
        positionMs: request.body.positionMs,
      });
      return reply.code(201).send({ id: event.id });
    },
  );
}
