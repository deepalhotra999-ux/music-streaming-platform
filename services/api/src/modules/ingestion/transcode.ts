// Phase 14 — artist audio ingestion. Source audio -> HLS package.
//
// Transcodes the validated upload into the same HLS layout the Phase 7
// playback pipeline serves: a master manifest, one AAC rendition playlist,
// and MPEG-TS segments. Output goes to a caller-provided local directory;
// the service layer uploads it to storage (staging keys) afterwards.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildMasterPlaylist } from '../streaming/hls.js';
import { IngestionError } from './errors.js';

const execFileAsync = promisify(execFile);

/** Rendition produced by the ingestion pipeline (matches Phase 7 dev audio). */
export const INGEST_RENDITION = '128k';
export const INGEST_BITRATE = '128k';
export const INGEST_BANDWIDTH = 128_000;
export const SEGMENT_SECONDS = 6;

/**
 * Transcode `sourcePath` into an HLS package under `outDir`:
 *   outDir/master.m3u8
 *   outDir/128k/index.m3u8
 *   outDir/128k/seg-00000.ts ...
 *
 * Throws IngestionError('transcode-failed') with a client-safe message.
 * Internal ffmpeg diagnostics are logged by the caller, never exposed.
 */
export async function transcodeToHls(sourcePath: string, outDir: string): Promise<void> {
  const renditionDir = path.join(outDir, INGEST_RENDITION);
  const mediaPlaylist = path.join(renditionDir, 'index.m3u8');
  await fs.mkdir(renditionDir, { recursive: true });

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        sourcePath,
        '-c:a',
        'aac',
        '-b:a',
        INGEST_BITRATE,
        '-ar',
        '44100',
        '-ac',
        '2',
        '-hls_time',
        String(SEGMENT_SECONDS),
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        path.join(renditionDir, 'seg-%05d.ts'),
        mediaPlaylist,
      ],
      { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (err) {
    throw new IngestionError(
      'transcode-failed',
      'The audio file could not be processed. It may use an unsupported codec or be corrupt.',
      err,
    );
  }

  await fs.writeFile(
    path.join(outDir, 'master.m3u8'),
    buildMasterPlaylist([{ name: INGEST_RENDITION, bandwidth: INGEST_BANDWIDTH }]),
  );
}
