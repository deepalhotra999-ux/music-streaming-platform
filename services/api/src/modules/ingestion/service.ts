// Phase 14 — artist audio ingestion pipeline.
//
// Lifecycle (stored in tracks.audio_status, independent of the catalog
// TrackStatus so re-processing a published track never unpublishes it):
//
//   NONE -> [upload] -> PENDING -> [worker claims] -> PROCESSING
//       -> READY (HLS package validated in storage) or FAILED (retryable)
//
// The worker claims a track with a single conditional UPDATE
// (audioStatus = PENDING -> PROCESSING), so two workers can never process
// the same track concurrently and a retry after failure is just
// FAILED -> PENDING -> PROCESSING.

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { PrismaClient, Track } from '@prisma/client';
import type { AuthUser } from '../../http/auth.js';
import { canManageArtist } from '../../http/authorization.js';
import { conflict, forbidden, notFound, unsupportedMediaType, unprocessableEntity } from '../../http/errors.js';
import {
  contentTypeForKey,
  masterKey,
  stagingKey,
  sourceKey,
  type AudioStorage,
} from '../streaming/storage.js';
import { SUPPORTED_FORMAT_LABELS, probeAudio, sniffFileFormat } from './audio.js';
import { transcodeToHls } from './transcode.js';
import { IngestionError, isIngestionError } from './errors.js';

export interface IngestionDeps {
  db: PrismaClient;
  storage: AudioStorage;
  log?: (message: string, detail?: unknown) => void;
}

export interface AudioStatusDto {
  trackId: string;
  audioStatus: 'NONE' | 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
  audioError: string | null;
  audioReadyAt: string | null;
}

export interface UploadInput {
  trackId: string;
  actor: AuthUser;
  /** Fully received upload on local disk; the caller enforces the size cap. */
  tmpPath: string;
  bytes: number;
}

type TrackWithArtist = Track & { artist: { id: string; ownerUserId: string } };

async function findTrackOr404(db: PrismaClient, trackId: string): Promise<TrackWithArtist> {
  const track = await db.track.findFirst({
    where: { id: trackId, deletedAt: null },
    include: { artist: { select: { id: true, ownerUserId: true } } },
  });
  if (!track) throw notFound('Track not found.');
  return track as TrackWithArtist;
}

function assertCanManage(actor: AuthUser, track: TrackWithArtist): void {
  if (!canManageArtist(actor, track.artist)) {
    throw forbidden('Only the owning artist (or an admin) can manage this track.');
  }
}

function toDto(track: Track): AudioStatusDto {
  return {
    trackId: track.id,
    audioStatus: track.audioStatus,
    audioError: track.audioError,
    audioReadyAt: track.audioReadyAt ? track.audioReadyAt.toISOString() : null,
  };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Wrap a storage call: provider failures become client-safe 'storage-error'. */
async function wrapStorage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isIngestionError(err)) throw err;
    throw new IngestionError(
      'storage-error',
      'Audio storage is temporarily unavailable. Please try again.',
      err,
    );
  }
}

/**
 * Validate and store an uploaded audio file, marking the track PENDING.
 * The caller streams the multipart body to `tmpPath` (enforcing the size
 * cap) and deletes it afterwards.
 */
export async function uploadTrackAudio(
  input: UploadInput,
  deps: IngestionDeps,
): Promise<AudioStatusDto> {
  const { db, storage } = deps;
  const track = await findTrackOr404(db, input.trackId);
  assertCanManage(input.actor, track);

  if (track.audioStatus === 'PENDING' || track.audioStatus === 'PROCESSING') {
    throw conflict('Audio is already being processed for this track.');
  }

  // Never trust the client filename or Content-Type: sniff magic bytes.
  const format = await sniffFileFormat(input.tmpPath);
  if (!format) {
    throw unsupportedMediaType(
      `Unsupported audio format. Supported formats: ${SUPPORTED_FORMAT_LABELS}.`,
    );
  }
  // And verify the file is genuinely decodable audio (ffprobe), not just
  // a renamed non-audio file with plausible magic bytes.
  try {
    await probeAudio(input.tmpPath);
  } catch (err) {
    throw unprocessableEntity(err instanceof Error ? err.message : 'Invalid audio file.');
  }

  // Private, server-generated key — the client cannot choose storage paths.
  const key = sourceKey(track.id, format.ext);
  await wrapStorage(() =>
    storage.putObject(key, createReadStream(input.tmpPath), {
      contentType: format.contentType,
      contentLength: input.bytes,
    }),
  );

  const previousKey = track.audioSourceKey;
  let updated;
  try {
    updated = await db.track.update({
      where: { id: track.id },
      data: { audioStatus: 'PENDING', audioError: null, audioSourceKey: key },
    });
  } catch (err) {
    // The new source blob has no owner if the record-of-truth update fails:
    // roll it back so it can't linger unreferenced in storage.
    await storage.deleteObject(key).catch(() => {});
    throw err;
  }
  // Best-effort: a re-upload would otherwise orphan the previous source
  // blob. The new key is already the record of truth, so a failed delete
  // must not fail the upload.
  if (previousKey && previousKey !== key) {
    await storage.deleteObject(previousKey).catch(() => {});
  }
  return toDto(updated);
}

/** FAILED -> PENDING so the queue picks the track up again. */
export async function retryTrackAudio(
  trackId: string,
  actor: AuthUser,
  deps: IngestionDeps,
): Promise<AudioStatusDto> {
  const track = await findTrackOr404(deps.db, trackId);
  assertCanManage(actor, track);
  if (track.audioStatus !== 'FAILED') {
    throw conflict('Only failed audio processing can be retried.');
  }
  if (!track.audioSourceKey) {
    throw conflict('No source audio is stored for this track. Upload audio first.');
  }
  const updated = await deps.db.track.update({
    where: { id: track.id },
    data: { audioStatus: 'PENDING', audioError: null },
  });
  return toDto(updated);
}

export async function getAudioStatus(
  trackId: string,
  actor: AuthUser,
  deps: IngestionDeps,
): Promise<AudioStatusDto> {
  const track = await findTrackOr404(deps.db, trackId);
  assertCanManage(actor, track);
  return toDto(track);
}

/** List all files under a directory, as '/'-separated relative paths. */
async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/**
 * Validate the staged HLS package *from storage* before anything becomes
 * visible to players: master manifest parses, every rendition playlist
 * parses and ends with EXT-X-ENDLIST, and every referenced segment exists
 * and is non-empty.
 */
async function validateStoredHls(trackId: string, storage: AudioStorage): Promise<void> {
  const fail = (message: string): never => {
    throw new IngestionError('validation-failed', message);
  };

  const readStagedText = async (relativePath: string): Promise<string> => {
    const obj = await wrapStorage(() => storage.getObject(stagingKey(trackId, relativePath)));
    if (!obj) fail('The processed audio package is incomplete.');
    return (await streamToBuffer(obj!.stream)).toString('utf8');
  };

  const master = await readStagedText('master.m3u8');
  const lines = master.split('\n').map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') fail('The processed audio package is invalid.');
  const renditionUris = lines.filter(
    (line, i) => i > 0 && lines[i - 1].startsWith('#EXT-X-STREAM-INF') && line && !line.startsWith('#'),
  );
  if (renditionUris.length === 0) fail('The processed audio package has no renditions.');
  if (renditionUris.length > 4) fail('The processed audio package is invalid.');

  for (const uri of renditionUris) {
    if (uri.includes('..') || uri.startsWith('/')) fail('The processed audio package is invalid.');
    const renditionDir = uri.split('/')[0];
    const media = await readStagedText(uri);
    // Filter blank lines: ffmpeg terminates playlists with a newline, so
    // the raw last element is '' rather than #EXT-X-ENDLIST.
    const mediaLines = media
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (mediaLines[0] !== '#EXTM3U') fail('The processed audio package is invalid.');
    if (!mediaLines.some((l) => l.startsWith('#EXTINF:'))) {
      fail('The processed audio package contains an empty rendition.');
    }
    if (mediaLines[mediaLines.length - 1] !== '#EXT-X-ENDLIST') {
      fail('The processed audio package is incomplete.');
    }
    const segments = mediaLines.filter((l) => l && !l.startsWith('#'));
    if (segments.length === 0) fail('The processed audio package contains an empty rendition.');
    for (const segment of segments) {
      if (segment.includes('..') || segment.startsWith('/')) {
        fail('The processed audio package is invalid.');
      }
      const info = await wrapStorage(() =>
        storage.stat(stagingKey(trackId, `${renditionDir}/${segment}`)),
      );
      if (!info || info.size === 0) fail('The processed audio package is incomplete.');
    }
  }
}

async function markFailed(
  deps: IngestionDeps,
  trackId: string,
  priorStatus: Track['status'],
  message: string,
): Promise<void> {
  await deps.db.track.update({
    where: { id: trackId },
    data: {
      audioStatus: 'FAILED',
      audioError: message,
      // A track that never had audio stays failed; a published track keeps
      // serving its previous HLS package and its catalog status.
      ...(priorStatus === 'PROCESSING' ? { status: 'FAILED' as const } : {}),
    },
  });
}

/**
 * Run the full pipeline for one track. Safe to call concurrently and to
 * re-run after failure: the PENDING -> PROCESSING claim is a single atomic
 * UPDATE, so exactly one worker proceeds and everyone else no-ops.
 * (Note: the startup recovery sweep in routes.ts is NOT safe for
 * simultaneous instances — see the single-instance limitation there.)
 */
export async function processTrackAudio(trackId: string, deps: IngestionDeps): Promise<void> {
  const { db, storage } = deps;
  const log = deps.log ?? (() => {});

  const claimed = await db.track.updateMany({
    where: { id: trackId, deletedAt: null, audioStatus: 'PENDING' },
    data: { audioStatus: 'PROCESSING', audioError: null },
  });
  if (claimed.count === 0) return; // already claimed / finished / retried — idempotent no-op

  const track = await db.track.findUnique({ where: { id: trackId } });
  if (!track || !track.audioSourceKey) {
    await markFailed(deps, trackId, track?.status ?? 'PROCESSING', 'The uploaded audio is missing. Please upload again.');
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-'));
  try {
    // 1. Fetch the private source into an isolated temp dir.
    const source = await wrapStorage(() => storage.getObject(track.audioSourceKey!));
    if (!source) {
      throw new IngestionError(
        'source-missing',
        'The uploaded audio is missing from storage. Please upload again.',
      );
    }
    const sourcePath = path.join(tmpDir, 'source');
    await pipeline(source.stream, createWriteStream(sourcePath));

    // 2. Cheap integrity re-check before the expensive transcode.
    let durationMs: number;
    try {
      const probe = await probeAudio(sourcePath);
      durationMs = Math.round(probe.durationSeconds * 1000);
    } catch {
      throw new IngestionError(
        'invalid-audio',
        'The uploaded audio is corrupt and could not be processed.',
      );
    }

    // 3. Transcode to a local HLS package.
    await transcodeToHls(sourcePath, path.join(tmpDir, 'hls'));

    // 4. Upload to staging keys (never directly to the playable layout).
    const files = await listFilesRecursive(path.join(tmpDir, 'hls'));
    for (const relative of files) {
      const absolute = path.join(tmpDir, 'hls', relative);
      const { size } = await fs.stat(absolute);
      await wrapStorage(() =>
        storage.putObject(stagingKey(trackId, relative), createReadStream(absolute), {
          contentType: contentTypeForKey(relative),
          contentLength: size,
        }),
      );
    }

    // 5. Validate the staged package from storage — READY is granted only
    //    after this passes.
    await validateStoredHls(trackId, storage);

    // 6. Promote to the playable layout in dependency order: segments,
    //    then rendition playlists, then the master manifest last, so the
    //    visible package is always complete.
    const promote = async (relative: string): Promise<void> => {
      await wrapStorage(() =>
        storage.copyObject(stagingKey(trackId, relative), `tracks/${trackId}/hls/${relative}`),
      );
    };
    for (const relative of files.filter((f) => f.endsWith('.ts'))) await promote(relative);
    for (const relative of files.filter((f) => f.endsWith('index.m3u8'))) await promote(relative);
    await promote('master.m3u8');

    // 7. Drop staging keys (best effort).
    await Promise.all(
      files.map((relative) => storage.deleteObject(stagingKey(trackId, relative)).catch(() => {})),
    );

    // 8. READY. A draft/failed track becomes playable now; an already
    //    published track keeps its catalog status (re-processing).
    //    Phase 25 — when previously-published audio is REPLACED, bump the
    //    audio version so pinned offline download authorizations detect the
    //    mismatch instead of silently playing outdated audio. audioReadyAt
    //    is set only by a successful completion, so a non-null value here
    //    means this track was published before (the local `track` row was
    //    loaded after the PENDING->PROCESSING claim, so its audioStatus is
    //    always PROCESSING at this point and cannot be used).
    const replacedPublishedAudio = track.audioReadyAt !== null;
    await db.track.update({
      where: { id: trackId },
      data: {
        audioStatus: 'READY',
        audioError: null,
        audioReadyAt: new Date(),
        durationMs,
        ...(replacedPublishedAudio ? { audioVersion: { increment: 1 } } : {}),
        ...(track.status === 'PROCESSING' || track.status === 'FAILED'
          ? { status: 'READY' as const }
          : {}),
      },
    });
    log(`ingestion: track ${trackId} READY`);
  } catch (err) {
    const message = isIngestionError(err)
      ? err.message
      : 'Audio processing failed unexpectedly. Please try again.';
    if (!isIngestionError(err)) log('ingestion: unexpected error', err);
    else if (err.cause_) log(`ingestion: track ${trackId} failed (${err.code})`, err.cause_);
    await markFailed(deps, trackId, track.status, message);
    // Best-effort staging cleanup so a later retry starts clean.
    try {
      const staged = await listFilesRecursive(path.join(tmpDir, 'hls')).catch(() => [] as string[]);
      await Promise.all(
        staged.map((relative) => storage.deleteObject(stagingKey(trackId, relative)).catch(() => {})),
      );
    } catch {
      // ignore
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** Convenience for tests: the final master-manifest key a player would use. */
export function finalMasterKey(trackId: string): string {
  return masterKey(trackId);
}
