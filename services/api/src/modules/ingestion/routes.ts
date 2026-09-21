// Phase 14 — artist audio ingestion. HTTP routes.
//
//   POST /v1/tracks/:id/audio        upload source audio (ARTIST owner / ADMIN)
//   GET  /v1/tracks/:id/audio        ingestion status (same audience)
//   POST /v1/tracks/:id/audio/retry  re-queue a failed ingestion
//
// Uploads arrive as multipart field "audio". The body is streamed to a temp
// file with a hard size cap; the service then sniffs magic bytes and runs
// ffprobe (never trusting client MIME/filename) before the bytes reach
// storage under a server-generated private key. Processing runs on a
// background queue; the upload responds 202 immediately.

import { createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import type { Config } from '../../config.js';
import { apiRateLimit } from '../../http/limits.js';
import { requireRole } from '../../http/authorization.js';
import { badRequest, payloadTooLarge } from '../../http/errors.js';
import { prisma } from '../../db.js';
import { createAudioStorage } from '../streaming/storage.js';
import {
  getAudioStatus,
  processTrackAudio,
  retryTrackAudio,
  uploadTrackAudio,
  type IngestionDeps,
} from './service.js';
import { IngestionQueue } from './queue.js';
import { audioStatusSchema, trackIdParamSchema } from './schemas.js';

const FILE_TOO_LARGE = 'FILE_TOO_LARGE';

export async function ingestionRoutes(app: FastifyInstance, config: Config): Promise<void> {
  // The multipart parser truncates file streams at its fileSize limit
  // (default: Fastify's 1 MiB bodyLimit) instead of erroring to a direct
  // `part.file` consumer, so the limit must match the ingestion cap and the
  // handler must check `truncated` after streaming. Without this, uploads
  // larger than 1 MiB would be silently cut off and processed as complete.
  await app.register(multipart, {
    limits: { fileSize: config.ingestion.maxUploadBytes },
  });
  const limit = apiRateLimit(config);

  // One storage handle per app instance; the driver is chosen at startup.
  const storage = await createAudioStorage(config);
  const deps: IngestionDeps = {
    db: prisma,
    storage,
    log: (message: string, detail?: unknown) => {
      if (detail !== undefined) app.log.info({ detail }, message);
      else app.log.info(message);
    },
  };
  // Sequential background processing; the DB claim keeps it safe even if
  // this ever runs on more than one instance.
  const queue = new IngestionQueue((trackId) => processTrackAudio(trackId, deps));

  // Crash recovery: the in-process queue does not survive a restart, so a
  // track left in PROCESSING belonged to a dead worker — requeue it as
  // PENDING. Also pick up any PENDING tracks that never got claimed.
  //
  // SINGLE-INSTANCE LIMITATION: this blanket PROCESSING -> PENDING sweep
  // is only safe when exactly one API instance runs at a time. If two
  // instances ever started simultaneously, the second sweep could steal
  // the first instance's in-flight job back to PENDING (the conditional
  // PENDING -> PROCESSING claim in processTrackAudio only serializes
  // queue claims; it cannot protect against a concurrent startup sweep).
  // A horizontally scaled deployment must replace this with a distributed
  // queue (e.g. Postgres advisory locks or a job table with heartbeats)
  // before running more than one instance.
  const interrupted = await prisma.track.updateMany({
    where: { audioStatus: 'PROCESSING' },
    data: { audioStatus: 'PENDING', audioError: null },
  });
  if (interrupted.count > 0) {
    app.log.info(`ingestion: requeued ${interrupted.count} interrupted job(s)`);
  }
  const pending = await prisma.track.findMany({
    where: { audioStatus: 'PENDING' },
    select: { id: true },
  });
  for (const t of pending) queue.enqueue(t.id);

  app.post(
    '/v1/tracks/:id/audio',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      config: { rateLimit: limit },
      schema: {
        tags: ['Ingestion'],
        summary: 'Upload source audio for an owned track',
        params: trackIdParamSchema,
        response: { 202: audioStatusSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      let part: Awaited<ReturnType<typeof req.file>>;
      try {
        part = await req.file();
      } catch {
        part = undefined;
      }
      if (!part || part.fieldname !== 'audio') {
        throw badRequest('Attach the audio file as multipart field "audio".');
      }

      // Stream to a temp file with a hard cap — oversized bodies are
      // discarded before validation or storage.
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-'));
      const tmpPath = path.join(tmpDir, 'audio');
      const maxBytes = config.ingestion.maxUploadBytes;
      let bytes = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) callback(new Error(FILE_TOO_LARGE));
          else callback(null, chunk);
        },
      });
      try {
        await pipeline(part.file, cap, createWriteStream(tmpPath));
      } catch (err) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        if (err instanceof Error && err.message === FILE_TOO_LARGE) {
          throw payloadTooLarge(
            `Audio files are limited to ${Math.round(maxBytes / 1024 / 1024)} MB.`,
          );
        }
        throw err;
      }
      // busboy sets `truncated` when the fileSize limit above cut the stream
      // short — the parser never surfaces this as an error to pipeline().
      if ((part.file as unknown as { truncated?: boolean }).truncated) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        throw payloadTooLarge(
          `Audio files are limited to ${Math.round(maxBytes / 1024 / 1024)} MB.`,
        );
      }

      try {
        const dto = await uploadTrackAudio(
          { trackId: id, actor: req.authUser!, tmpPath, bytes },
          deps,
        );
        queue.enqueue(id);
        return reply.code(202).send(dto);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  app.get(
    '/v1/tracks/:id/audio',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      config: { rateLimit: limit },
      schema: {
        tags: ['Ingestion'],
        summary: 'Get audio ingestion status for a track',
        params: trackIdParamSchema,
        response: { 200: audioStatusSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply.code(200).send(await getAudioStatus(id, req.authUser!, deps));
    },
  );

  app.post(
    '/v1/tracks/:id/audio/retry',
    {
      preHandler: [app.authenticate, requireRole('ARTIST', 'ADMIN')],
      config: { rateLimit: limit },
      schema: {
        tags: ['Ingestion'],
        summary: 'Retry failed audio processing for a track',
        params: trackIdParamSchema,
        response: { 202: audioStatusSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const dto = await retryTrackAudio(id, req.authUser!, deps);
      queue.enqueue(id);
      return reply.code(202).send(dto);
    },
  );
}
