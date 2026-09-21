#!/usr/bin/env npx tsx
/**
 * Phase 7 — development audio asset generator.
 *
 * Generates HLS packages for every READY track in the database using
 * ffmpeg's `sine` source — locally synthesized test audio, never copyrighted
 * material. Each track gets a distinct base frequency so the assets are
 * audibly distinguishable.
 *
 * Layout (matches the storage abstraction's key scheme):
 *   <AUDIO_STORAGE_DIR>/tracks/<trackId>/hls/master.m3u8
 *   <AUDIO_STORAGE_DIR>/tracks/<trackId>/hls/128k/index.m3u8
 *   <AUDIO_STORAGE_DIR>/tracks/<trackId>/hls/128k/seg-00000.ts ...
 *
 * Usage:
 *   npm run audio:generate            # uses AUDIO_STORAGE_DIR or ./storage/audio
 *   AUDIO_STORAGE_DIR=/tmp/audio npm run audio:generate
 *
 * Requirements: ffmpeg on PATH, DATABASE_URL (+ JWT_SECRET, required by
 * loadConfig) in the environment. Regenerating is idempotent — existing
 * packages are skipped unless --force is passed.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { prisma } from '../src/db.js';
import { buildMasterPlaylist } from '../src/modules/streaming/hls.js';

const execFileAsync = promisify(execFile);

const DURATION_SECONDS = 30;
const SEGMENT_SECONDS = 6;
const RENDITION = '128k';
const BITRATE = '128k';
// Base frequencies cycle so every track sounds different.
const FREQUENCIES = [220, 277.18, 329.63, 392, 440, 523.25, 659.25, 783.99];

const force = process.argv.includes('--force');

async function trackDir(root: string, trackId: string): Promise<string> {
  return path.join(root, 'tracks', trackId, 'hls');
}

async function generateTrack(root: string, trackId: string, index: number): Promise<void> {
  const dir = await trackDir(root, trackId);
  const renditionDir = path.join(dir, RENDITION);
  const mediaPlaylist = path.join(renditionDir, 'index.m3u8');
  const masterPlaylist = path.join(dir, 'master.m3u8');

  if (!force) {
    try {
      await fs.access(masterPlaylist);
      console.log(`  skip ${trackId} (exists, use --force to regenerate)`);
      return;
    } catch {
      // generate below
    }
  }

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(renditionDir, { recursive: true });

  const freq = FREQUENCIES[index % FREQUENCIES.length];
  // Gentle stereo sine with a slow tremolo so segments are easy to tell apart.
  const filter = `sine=frequency=${freq}:duration=${DURATION_SECONDS},tremolo=f=0.5:d=0.5`;
  await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    filter,
    '-c:a',
    'aac',
    '-b:a',
    BITRATE,
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
  ]);

  await fs.writeFile(masterPlaylist, buildMasterPlaylist([{ name: RENDITION, bandwidth: 128_000 }]));
  console.log(`  generated ${trackId} (${freq} Hz, ${DURATION_SECONDS}s)`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const root = path.resolve(config.streaming.audioStorageDir);
  console.log(`Generating dev HLS audio into ${root}`);

  const tracks = await prisma.track.findMany({
    where: { status: 'READY', deletedAt: null },
    select: { id: true, title: true },
    orderBy: { createdAt: 'asc' },
  });
  if (tracks.length === 0) {
    console.log('No READY tracks found. Seed the database first (npm run db:seed).');
    return;
  }
  console.log(`Found ${tracks.length} READY track(s).`);
  let i = 0;
  for (const track of tracks) {
    await generateTrack(root, track.id, i++);
  }
  console.log('Done.');
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
