/**
 * Phase 14 — artist audio upload & processing pipeline tests.
 *
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL (never the
 * dev DB), plus service-level pipeline tests with real ffmpeg/ffprobe and
 * the local storage driver. The S3 driver is tested against a fake
 * S3Client — no AWS credentials or network are used anywhere in this file.
 *
 * Covers: magic-byte format sniffing, upload validation (415/422/413/400),
 * the authz matrix (401/403 incl. ADMIN bypass and cross-owner denial),
 * the PENDING -> PROCESSING -> READY/FAILED state machine, idempotent
 * job claims (concurrent + repeated processing), FAILED -> retry -> READY
 * through the real background queue, failed re-processing of a published
 * track (catalog status + previous HLS preserved), staged HLS validation
 * from storage, playback compatibility after the pipeline, and the
 * in-process queue (ordering, dedup, failure isolation).
 *
 * Cleanup is scoped to `@ingestion-test.local` addresses plus the temp
 * audio/fixtures dirs. ffmpeg/ffprobe must be on PATH.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';
import type { AuthUser } from '../src/http/auth.js';
import { sniffAudioFormat } from '../src/modules/ingestion/audio.js';
import { transcodeToHls } from '../src/modules/ingestion/transcode.js';
import {
  getAudioStatus,
  processTrackAudio,
  retryTrackAudio,
  uploadTrackAudio,
  type IngestionDeps,
} from '../src/modules/ingestion/service.js';
import { IngestionQueue } from '../src/modules/ingestion/queue.js';
import {
  LocalFileStorage,
  type PutOptions,
  type S3ClientType,
  S3Storage,
  createAudioStorage,
  masterKey,
  mediaPlaylistKey,
  segmentKey,
  sourceKey,
  stagingKey,
} from '../src/modules/streaming/storage.js';

const execFileAsync = promisify(execFile);

// --- Fixtures ----------------------------------------------------------------

const TEST_DOMAIN = '@ingestion-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase14-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;
let audioDir: string;
let fixturesDir: string;
let storage: LocalFileStorage;
let deps: IngestionDeps;

interface TestUser {
  id: string;
  email: string;
  token: string;
}

let ownerArtist: TestUser;
let otherArtist: TestUser;
let listener: TestUser;
let admin: TestUser;

const actorFor = (user: TestUser, role: string): AuthUser => ({
  id: user.id,
  email: user.email,
  role,
});
const ownerActor = () => actorFor(ownerArtist, 'ARTIST');

let artist1Id: string;
let artist2Id: string;
let uploadTrackId: string; // owned by artist1 — HTTP upload/authz tests
let retryTrackId: string; // owned by artist1 — retry/e2e test
let foreignTrackId: string; // owned by artist2 — cross-owner denial
let legacyReadyTrackId: string; // READY + hand-written HLS (Phase 7 style)

async function createUser(tag: string, role: 'LISTENER' | 'ARTIST' | 'ADMIN'): Promise<TestUser> {
  const email = testEmail(tag);
  const reg = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: PASSWORD, displayName: `${tag} User` },
  });
  expect(reg.statusCode).toBe(201);
  const userId = reg.json().user.id as string;
  if (role !== 'LISTENER') {
    await prisma.user.update({ where: { id: userId }, data: { role } });
  }
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  return { id: userId, email, token: login.json().tokens.accessToken as string };
}

const auth = (user: TestUser) => ({ authorization: `Bearer ${user.token}` });

/** FK-safe cleanup, children before parents. */
async function scopedClean(): Promise<void> {
  const userWhere = { user: { email: { endsWith: TEST_DOMAIN } } };
  await prisma.playEvent.deleteMany({ where: userWhere });
  await prisma.playbackSession.deleteMany({ where: userWhere });
  await prisma.track.deleteMany({
    where: { artist: { owner: { email: { endsWith: TEST_DOMAIN } } } },
  });
  await prisma.artist.deleteMany({ where: { owner: { email: { endsWith: TEST_DOMAIN } } } });
  await prisma.refreshToken.deleteMany({ where: userWhere });
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
}

async function synthAudio(outPath: string, seconds: number, codecArgs: string[] = []): Promise<void> {
  await execFileAsync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:duration=${seconds}`,
      ...codecArgs,
      '-ar',
      '44100',
      '-ac',
      '2',
      outPath,
    ],
    { timeout: 120_000 },
  );
}

function fixturePath(name: string): string {
  return path.join(fixturesDir, name);
}

function multipartUpload(boundary: string, filename: string, mimeType: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
      'utf8',
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
}

async function uploadFile(
  user: TestUser | null,
  trackId: string,
  filename: string,
  mimeType: string,
  data: Buffer,
) {
  const boundary = 'phase14-test-boundary';
  return app.inject({
    method: 'POST',
    url: `/v1/tracks/${trackId}/audio`,
    headers: {
      ...(user ? auth(user) : {}),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: multipartUpload(boundary, filename, mimeType, data),
  });
}

const readFile = (name: string) => fs.readFile(fixturePath(name));

async function makeTrack(title: string, artistId: string): Promise<string> {
  const t = await prisma.track.create({
    data: { title, artistId, durationMs: 3000 },
    select: { id: true },
  });
  return t.id;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function getObjectText(key: string): Promise<string | null> {
  const obj = await storage.getObject(key);
  if (!obj) return null;
  return (await streamToBuffer(obj.stream)).toString('utf8');
}

async function audioSourceKey(trackId: string): Promise<string | null> {
  const track = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
  return track.audioSourceKey;
}

/** Service-level upload: copies a fixture to a temp path the service validates. */
async function serviceUpload(
  trackId: string,
  fixtureName: string,
  actor: AuthUser = ownerActor(),
) {
  const tmp = path.join(os.tmpdir(), `phase14-${Date.now()}-${counter++}.up`);
  await fs.copyFile(fixturePath(fixtureName), tmp);
  const { size } = await fs.stat(tmp);
  try {
    return await uploadTrackAudio({ trackId, actor, tmpPath: tmp, bytes: size }, deps);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function writeHlsPackage(trackId: string): Promise<void> {
  const base = path.join(audioDir, 'tracks', trackId, 'hls');
  const rendition = path.join(base, '128k');
  await fs.mkdir(rendition, { recursive: true });
  await fs.writeFile(
    path.join(base, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\n128k/index.m3u8\n',
  );
  await fs.writeFile(
    path.join(rendition, 'index.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n' +
      '#EXTINF:6.0,\nseg-00000.ts\n#EXTINF:6.0,\nseg-00001.ts\n#EXT-X-ENDLIST\n',
  );
  await fs.writeFile(path.join(rendition, 'seg-00000.ts'), Buffer.alloc(1024, 0x41));
  await fs.writeFile(path.join(rendition, 'seg-00001.ts'), Buffer.alloc(512, 0x42));
}

beforeAll(async () => {
  audioDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase14-audio-'));
  fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase14-fixtures-'));
  config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    RATE_LIMIT_LOGIN: '1000',
    RATE_LIMIT_REGISTER: '1000',
    RATE_LIMIT_REFRESH: '1000',
    RATE_LIMIT_LOGOUT: '1000',
    RATE_LIMIT_API: '10000',
    RATE_LIMIT_STREAMING: '10000',
    AUDIO_STORAGE_DRIVER: 'local',
    AUDIO_STORAGE_DIR: audioDir,
    INGESTION_MAX_UPLOAD_BYTES: String(1024 * 1024), // 1 MiB
    PLAYBACK_SESSION_TTL_SECONDS: '900',
  });
  app = await buildApp(config);
  await scopedClean();

  storage = new LocalFileStorage(audioDir);
  deps = { db: prisma, storage };

  ownerArtist = await createUser('owner', 'ARTIST');
  otherArtist = await createUser('other', 'ARTIST');
  listener = await createUser('listener', 'LISTENER');
  admin = await createUser('admin', 'ADMIN');

  artist1Id = (await prisma.artist.create({ data: { name: 'P14 Artist One', ownerUserId: ownerArtist.id } })).id;
  artist2Id = (await prisma.artist.create({ data: { name: 'P14 Artist Two', ownerUserId: otherArtist.id } })).id;

  uploadTrackId = await makeTrack('Upload Target', artist1Id);
  retryTrackId = await makeTrack('Retry Target', artist1Id);
  foreignTrackId = await makeTrack('Foreign Track', artist2Id);
  legacyReadyTrackId = (
    await prisma.track.create({
      data: {
        title: 'Legacy Ready Track',
        artistId: artist1Id,
        durationMs: 12_000,
        status: 'READY',
        audioStatus: 'READY',
        audioReadyAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  await writeHlsPackage(legacyReadyTrackId);

  await synthAudio(fixturePath('valid.wav'), 3);
  await synthAudio(fixturePath('valid.mp3'), 3, ['-codec:a', 'libmp3lame']);
  await synthAudio(fixturePath('big.wav'), 30); // ~5.3 MB > 1 MiB cap -> 413
  await fs.writeFile(fixturePath('not-audio.txt'), 'this is plainly not audio data');
  await fs.writeFile(
    fixturePath('fake.mp3'),
    Buffer.concat([Buffer.from('ID3', 'utf8'), Buffer.alloc(1024, 0x00)]),
  );
}, 120_000);

afterAll(async () => {
  await scopedClean();
  await app.close();
  await prisma.$disconnect();
  await fs.rm(audioDir, { recursive: true, force: true });
  await fs.rm(fixturesDir, { recursive: true, force: true });
});

// --- Unit: magic-byte sniffing ------------------------------------------------

describe('sniffAudioFormat', () => {
  it('detects WAV by RIFF....WAVE', () => {
    expect(sniffAudioFormat(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt extra', 'binary'))).toMatchObject({
      ext: 'wav',
    });
  });
  it('detects FLAC by fLaC', () => {
    expect(sniffAudioFormat(Buffer.from('fLaC\x00\x00\x00\x22padding!', 'binary'))).toMatchObject({
      ext: 'flac',
    });
  });
  it('detects Ogg by OggS', () => {
    expect(sniffAudioFormat(Buffer.from('OggS\x00\x02\x00\x00padding!', 'binary'))).toMatchObject({
      ext: 'ogg',
    });
  });
  it('detects M4A/AAC by ....ftyp', () => {
    expect(sniffAudioFormat(Buffer.from('\x00\x00\x00\x20ftypM4A padding', 'binary'))).toMatchObject({
      ext: 'm4a',
    });
  });
  it('detects MP3 by ID3 tag and by frame sync', () => {
    expect(
      sniffAudioFormat(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00', 'binary')),
    ).toMatchObject({ ext: 'mp3' });
    expect(
      sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])),
    ).toMatchObject({ ext: 'mp3' });
  });
  it('returns null for unknown data and short buffers', () => {
    expect(sniffAudioFormat(Buffer.from('this is plainly not audio data', 'utf8'))).toBeNull();
    expect(sniffAudioFormat(Buffer.from([0xff, 0xfb]))).toBeNull();
    expect(sniffAudioFormat(Buffer.alloc(0))).toBeNull();
  });
});

// --- Unit: ingestion queue ----------------------------------------------------

describe('IngestionQueue', () => {
  it('processes jobs sequentially in enqueue order', async () => {
    const order: string[] = [];
    const q = new IngestionQueue(async (id) => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(id);
    });
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    await q.onIdle();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('dedupes: one in-flight job per track', async () => {
    let runs = 0;
    const q = new IngestionQueue(async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 30));
    });
    q.enqueue('same');
    q.enqueue('same');
    q.enqueue('same');
    await q.onIdle();
    expect(runs).toBe(1);
  });

  it('a failing job does not wedge the chain', async () => {
    const done: string[] = [];
    const q = new IngestionQueue(async (id) => {
      if (id === 'boom') throw new Error('job exploded');
      done.push(id);
    });
    q.enqueue('boom');
    q.enqueue('after');
    await q.onIdle();
    expect(done).toEqual(['after']);
    expect(q.pendingCount).toBe(0);
  });
});

// --- Unit: storage key builders ------------------------------------------------

describe('ingestion storage keys', () => {
  it('builds server-generated source and staging keys under the track', () => {
    expect(sourceKey('t1', 'wav')).toMatch(/^tracks\/t1\/source\/[0-9a-f-]+\.wav$/);
    expect(stagingKey('t1', '128k/index.m3u8')).toBe('tracks/t1/hls-staging/128k/index.m3u8');
  });
  it('source keys never collide for the same track', () => {
    expect(sourceKey('t1', 'mp3')).not.toBe(sourceKey('t1', 'mp3'));
  });
});

// --- Unit: transcode ------------------------------------------------------------

describe('transcodeToHls', () => {
  it('produces a master manifest, one AAC rendition and segments', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase14-transcode-'));
    try {
      const files = await transcodeToHls(fixturePath('valid.wav'), outDir);
      expect(files).toBeUndefined(); // returns void; outputs are on disk
      const master = await fs.readFile(path.join(outDir, 'master.m3u8'), 'utf8');
      expect(master).toMatch(/^#EXTM3U/);
      expect(master).toContain('128k/index.m3u8');
      const media = await fs.readFile(path.join(outDir, '128k', 'index.m3u8'), 'utf8');
      expect(media).toContain('#EXT-X-ENDLIST');
      expect(media).toMatch(/#EXTINF/);
      const segFiles = (await fs.readdir(path.join(outDir, '128k'))).filter((f) =>
        f.endsWith('.ts'),
      );
      expect(segFiles.length).toBeGreaterThanOrEqual(1);
      const stat = await fs.stat(path.join(outDir, '128k', segFiles[0]));
      expect(stat.size).toBeGreaterThan(0);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// --- Service: upload validation ------------------------------------------------

describe('uploadTrackAudio validation', () => {
  it('rejects a non-audio file with 415 even when the filename claims mp3', async () => {
    const trackId = await makeTrack('Reject Non-Audio', artist1Id);
    await expect(serviceUpload(trackId, 'not-audio.txt')).rejects.toMatchObject({ status: 415 });
    const track = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.audioStatus).toBe('NONE');
    expect(track.audioSourceKey).toBeNull();
  });

  it('rejects a corrupt MP3 (valid magic, unplayable) with 422', async () => {
    const trackId = await makeTrack('Reject Corrupt', artist1Id);
    await expect(serviceUpload(trackId, 'fake.mp3')).rejects.toMatchObject({ status: 422 });
  });

  it('rejects a second upload while one is in flight with 409', async () => {
    const trackId = await makeTrack('Reject Duplicate', artist1Id);
    await prisma.track.update({ where: { id: trackId }, data: { audioStatus: 'PENDING' } });
    await expect(serviceUpload(trackId, 'valid.wav')).rejects.toMatchObject({ status: 409 });
  });

  it('rejects an upload for a track the actor does not own with 403', async () => {
    const trackId = await makeTrack('Reject Foreign', artist2Id);
    // ownerActor owns artist1, not artist2 -> forbidden.
    await expect(serviceUpload(trackId, 'valid.wav', ownerActor())).rejects.toMatchObject({
      status: 403,
    });
  });

  it('stores the source privately under a server-generated key and marks PENDING', async () => {
    const trackId = await makeTrack('Happy Upload', artist1Id);
    const result = await serviceUpload(trackId, 'valid.wav');
    expect(result.audioStatus).toBe('PENDING');
    expect(result.audioError).toBeNull();
    expect(result.audioReadyAt).toBeNull();
    // Server-generated, unguessable key — the client filename is ignored.
    const key = await audioSourceKey(trackId);
    expect(key).toMatch(new RegExp(`^tracks/${trackId}/source/[0-9a-f-]+\\.wav$`));
    // Source object is private: retrievable via storage, never a public URL.
    const obj = await storage.getObject(key!);
    expect(obj).not.toBeNull();
    expect(obj!.size).toBeGreaterThan(0);
  });
});

// --- Service: processing pipeline ---------------------------------------------

describe('processTrackAudio', () => {
  it('transcodes to HLS and flips PENDING -> READY with a valid package', async () => {
    const trackId = await makeTrack('Pipeline Happy', artist1Id);
    const uploaded = await serviceUpload(trackId, 'valid.wav');
    expect(uploaded.audioStatus).toBe('PENDING');

    await processTrackAudio(trackId, deps);

    const track = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.audioStatus).toBe('READY');
    expect(track.audioError).toBeNull();
    expect(track.audioReadyAt).not.toBeNull();
    expect(track.status).toBe('READY'); // draft -> published once audio is ready
    expect(track.durationMs).toBeGreaterThan(0);

    // Production keys exist and match the Phase 7 playback layout.
    expect(await getObjectText(masterKey(trackId))).toMatch(/^#EXTM3U/);
    expect(await getObjectText(mediaPlaylistKey(trackId, '128k'))).toContain('#EXT-X-ENDLIST');
    const firstSeg = await storage.getObject(segmentKey(trackId, '128k', 'seg-00000.ts'));
    expect(firstSeg).not.toBeNull();
    expect(firstSeg!.size).toBeGreaterThan(0);

    // Staging keys are gone — readers never see a half-written package.
    expect(await storage.exists(stagingKey(trackId, 'master.m3u8'))).toBe(false);

    // The private source object is retained for future re-processing.
    const key = await audioSourceKey(trackId);
    expect(await storage.exists(key!)).toBe(true);
  }, 60_000);

  it('is idempotent: concurrent and repeated claims process only once', async () => {
    const trackId = await makeTrack('Idempotent', artist1Id);
    await serviceUpload(trackId, 'valid.wav');

    await Promise.all([
      processTrackAudio(trackId, deps),
      processTrackAudio(trackId, deps),
      processTrackAudio(trackId, deps),
    ]);
    const afterConcurrent = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(afterConcurrent.audioStatus).toBe('READY');

    // A repeat after READY is a no-op: the ready timestamp does not move.
    await processTrackAudio(trackId, deps);
    const afterRepeat = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(afterRepeat.audioReadyAt?.getTime()).toBe(afterConcurrent.audioReadyAt?.getTime());
  }, 60_000);

  it('marks FAILED with a client-safe message when the source is missing', async () => {
    const trackId = await makeTrack('Missing Source', artist1Id);
    await serviceUpload(trackId, 'valid.wav');
    const key = await audioSourceKey(trackId);
    await storage.deleteObject(key!); // source vanished

    await processTrackAudio(trackId, deps);

    const track = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.audioStatus).toBe('FAILED');
    expect(track.audioError).toBe('The uploaded audio is missing from storage. Please upload again.');
    expect(track.audioReadyAt).toBeNull();
    expect(track.status).toBe('FAILED'); // never published without playable audio
  }, 60_000);

  it('marks FAILED when the staged HLS package fails validation', async () => {
    const trackId = await makeTrack('Bad Package', artist1Id);
    await serviceUpload(trackId, 'valid.wav');

    // Corrupt only the staged master manifest; production keys stay clean.
    class CorruptingStorage extends LocalFileStorage {
      override async putObject(
        key: string,
        body: Buffer | NodeJS.ReadableStream,
        options?: PutOptions,
      ): Promise<void> {
        if (key.includes('hls-staging') && key.endsWith('master.m3u8')) {
          return super.putObject(key, Buffer.from('garbage-not-a-manifest'), options);
        }
        return super.putObject(key, body, options);
      }
    }
    await processTrackAudio(trackId, { db: prisma, storage: new CorruptingStorage(audioDir) });

    const track = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.audioStatus).toBe('FAILED');
    expect(track.audioError).toMatch(/invalid/i);
    // The corrupt staging master never promoted to production.
    expect(await storage.exists(masterKey(trackId))).toBe(false);
  }, 60_000);

  it('a failed re-processing keeps a published track playable with its old HLS', async () => {
    const trackId = await makeTrack('Published Reprocess', artist1Id);
    await serviceUpload(trackId, 'valid.wav');
    await processTrackAudio(trackId, deps);
    const before = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(before.audioStatus).toBe('READY');
    const oldMaster = await getObjectText(masterKey(trackId));
    expect(oldMaster).not.toBeNull();

    // Re-upload, then lose the new source before processing.
    await serviceUpload(trackId, 'valid.mp3');
    const newKey = await audioSourceKey(trackId);
    await storage.deleteObject(newKey!);
    await processTrackAudio(trackId, deps);

    const after = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(after.audioStatus).toBe('FAILED');
    expect(after.status).toBe('READY'); // catalog state untouched by the failed re-run
    expect(await getObjectText(masterKey(trackId))).toBe(oldMaster);
  }, 60_000);

  it('retryTrackAudio flips FAILED -> PENDING but refuses non-FAILED states', async () => {
    const trackId = await makeTrack('Retry Rules', artist1Id);
    await expect(retryTrackAudio(trackId, ownerActor(), deps)).rejects.toMatchObject({
      status: 409,
    });
    await serviceUpload(trackId, 'valid.wav');
    const key = await audioSourceKey(trackId);
    await storage.deleteObject(key!);
    await processTrackAudio(trackId, deps);
    expect((await prisma.track.findUniqueOrThrow({ where: { id: trackId } })).audioStatus).toBe('FAILED');
    const retried = await retryTrackAudio(trackId, ownerActor(), deps);
    expect(retried.audioStatus).toBe('PENDING');
    expect(retried.audioError).toBeNull();
  }, 60_000);

  it('re-upload deletes the previous source blob (no orphaned sources)', async () => {
    const trackId = await makeTrack('Reupload Cleanup', artist1Id);
    await serviceUpload(trackId, 'valid.wav');
    const firstKey = await audioSourceKey(trackId);
    expect(await storage.exists(firstKey!)).toBe(true);

    // Finish the first job (as the background queue would), then re-upload.
    await processTrackAudio(trackId, deps);
    expect((await prisma.track.findUniqueOrThrow({ where: { id: trackId } })).audioStatus).toBe('READY');

    await serviceUpload(trackId, 'valid.mp3');
    const secondKey = await audioSourceKey(trackId);
    expect(secondKey).not.toBe(firstKey);
    // Old source is gone; the new one is stored.
    expect(await storage.exists(firstKey!)).toBe(false);
    expect(await storage.exists(secondKey!)).toBe(true);
  }, 60_000);

  it('a failed record update rolls back the newly stored source blob', async () => {
    const trackId = await makeTrack('Rollback Cleanup', artist1Id);
    const sourceDir = path.join(audioDir, 'tracks', trackId, 'source');
    const failingDeps = {
      ...deps,
      db: {
        ...prisma,
        track: { ...prisma.track, update: () => Promise.reject(new Error('db down')) },
      } as unknown as PrismaClient,
    };

    const tmp = path.join(os.tmpdir(), `phase14-${Date.now()}-${counter++}.up`);
    await fs.copyFile(fixturePath('valid.wav'), tmp);
    const { size } = await fs.stat(tmp);
    try {
      await expect(
        uploadTrackAudio({ trackId, actor: ownerActor(), tmpPath: tmp, bytes: size }, failingDeps),
      ).rejects.toThrow('db down');
    } finally {
      await fs.rm(tmp, { force: true });
    }

    // The blob was stored before the update failed; the rollback must have
    // removed it so no unreferenced object lingers in storage.
    const entries = await fs.readdir(sourceDir).catch(() => [] as string[]);
    expect(entries).toEqual([]);
  }, 60_000);

  it('startup requeues a track stuck in PROCESSING (dead worker recovery)', async () => {
    const trackId = await makeTrack('Crash Recovery', artist1Id);
    await serviceUpload(trackId, 'valid.wav');
    // Simulate a worker that claimed the job then died: PROCESSING in the
    // DB, but nothing is actually working on it.
    await prisma.track.update({ where: { id: trackId }, data: { audioStatus: 'PROCESSING' } });

    // Booting a fresh app runs the recovery sweep and processes the job.
    const app2 = await buildApp(config);
    try {
      const deadline = Date.now() + 30_000;
      let status = 'PROCESSING';
      while (status === 'PROCESSING' || status === 'PENDING') {
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 500));
        status = (await prisma.track.findUniqueOrThrow({ where: { id: trackId } })).audioStatus;
      }
      expect(status).toBe('READY');
    } finally {
      await app2.close();
    }
  }, 60_000);
});

// --- HTTP: upload authz ---------------------------------------------------------

describe('POST /v1/tracks/:id/audio authz', () => {
  it('401 without a token', async () => {
    const res = await uploadFile(null, uploadTrackId, 'x.wav', 'audio/wav', await readFile('valid.wav'));
    expect(res.statusCode).toBe(401);
  });

  it('403 for a LISTENER', async () => {
    const res = await uploadFile(listener, uploadTrackId, 'x.wav', 'audio/wav', await readFile('valid.wav'));
    expect(res.statusCode).toBe(403);
  });

  it('403 for an ARTIST who does not own the track', async () => {
    const res = await uploadFile(otherArtist, uploadTrackId, 'x.wav', 'audio/wav', await readFile('valid.wav'));
    expect(res.statusCode).toBe(403);
  });

  it('404 for a track that does not exist', async () => {
    const res = await uploadFile(
      ownerArtist,
      '00000000-0000-0000-0000-000000000000',
      'x.wav',
      'audio/wav',
      await readFile('valid.wav'),
    );
    expect(res.statusCode).toBe(404);
  });

  it('403 for another artist’s track even to the owner (matches catalog write routes)', async () => {
    const res = await uploadFile(ownerArtist, foreignTrackId, 'x.wav', 'audio/wav', await readFile('valid.wav'));
    expect(res.statusCode).toBe(403);
  });

  it('202 for the owning ARTIST, returning the ingestion status', async () => {
    const trackId = await makeTrack('Owner Upload', artist1Id);
    const res = await uploadFile(ownerArtist, trackId, 'song.wav', 'audio/wav', await readFile('valid.wav'));
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.trackId).toBe(trackId);
    expect(body.audioStatus).toBe('PENDING');
    expect(body.audioError).toBeNull();
    expect(body.audioReadyAt).toBeNull();
    // The background queue will process this track; nothing to assert further.
  });

  it('202 for an ADMIN on someone else’s track', async () => {
    const trackId = await makeTrack('Admin Upload', artist2Id);
    const res = await uploadFile(admin, trackId, 'a.wav', 'audio/wav', await readFile('valid.wav'));
    expect(res.statusCode).toBe(202);
  });
});

// --- HTTP: upload validation ----------------------------------------------------

describe('POST /v1/tracks/:id/audio validation', () => {
  it('400 when no file part is sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/tracks/${uploadTrackId}/audio`,
      headers: auth(ownerArtist),
      payload: { note: 'no file here' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('415 for a non-audio file even with an audio/* content type', async () => {
    const res = await uploadFile(ownerArtist, uploadTrackId, 'evil.mp3', 'audio/mpeg', await readFile('not-audio.txt'));
    expect(res.statusCode).toBe(415);
    expect(res.json().title).toMatch(/unsupported media type/i);
  });

  it('422 for a corrupt file that sniffs as audio but does not probe', async () => {
    const res = await uploadFile(ownerArtist, uploadTrackId, 'fake.mp3', 'audio/mpeg', await readFile('fake.mp3'));
    expect(res.statusCode).toBe(422);
  });

  it('413 for a file over the configured upload limit', async () => {
    const big = await readFile('big.wav');
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const res = await uploadFile(ownerArtist, uploadTrackId, 'big.wav', 'audio/wav', big);
    expect(res.statusCode).toBe(413);
  });

  it('accepts mp3 uploads too (not just wav)', async () => {
    const trackId = await makeTrack('MP3 Upload', artist1Id);
    const res = await uploadFile(ownerArtist, trackId, 'song.mp3', 'audio/mpeg', await readFile('valid.mp3'));
    expect(res.statusCode).toBe(202);
  });
});

// --- HTTP: status + retry ----------------------------------------------------------

describe('GET /v1/tracks/:id/audio and POST .../retry', () => {
  it('returns the ingestion status shape; 404/403 enforced', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/v1/tracks/${uploadTrackId}/audio`,
      headers: auth(ownerArtist),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ trackId: uploadTrackId });

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/tracks/00000000-0000-0000-0000-000000000000/audio',
      headers: auth(ownerArtist),
    });
    expect(missing.statusCode).toBe(404);

    const foreign = await app.inject({
      method: 'GET',
      url: `/v1/tracks/${foreignTrackId}/audio`,
      headers: auth(ownerArtist),
    });
    expect(foreign.statusCode).toBe(403);

    const listenerDenied = await app.inject({
      method: 'GET',
      url: `/v1/tracks/${uploadTrackId}/audio`,
      headers: auth(listener),
    });
    expect(listenerDenied.statusCode).toBe(403);
  });

  it('FAILED -> retry -> READY through the real background queue', async () => {
    // 1. Service-level upload keeps the in-process queue out of the picture.
    await serviceUpload(retryTrackId, 'valid.wav');
    // 2. Lose the source -> deterministic pipeline failure.
    const key = await audioSourceKey(retryTrackId);
    await storage.deleteObject(key!);
    await processTrackAudio(retryTrackId, deps);
    const failed = await getAudioStatus(retryTrackId, ownerActor(), deps);
    expect(failed.audioStatus).toBe('FAILED');
    // 3. Restore the source object (as a re-upload would) and retry via HTTP.
    await storage.putObject(key!, await readFile('valid.wav'), { contentType: 'audio/wav' });
    const retried = await app.inject({
      method: 'POST',
      url: `/v1/tracks/${retryTrackId}/audio/retry`,
      headers: auth(ownerArtist),
    });
    expect(retried.statusCode).toBe(202);
    expect(retried.json().audioStatus).toBe('PENDING');
    // 4. The route enqueued a background job — poll until it lands.
    const deadline = Date.now() + 30_000;
    let status = retried.json();
    for (;;) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/tracks/${retryTrackId}/audio`,
        headers: auth(ownerArtist),
      });
      status = res.json();
      if (status.audioStatus === 'READY' || status.audioStatus === 'FAILED') break;
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(status.audioStatus).toBe('READY');
    expect(status.audioReadyAt).not.toBeNull();
  }, 60_000);
});

// --- HTTP: playback compatibility ----------------------------------------------------

describe('playback after Phase 14 processing', () => {
  it('a pipeline-produced track plays through the Phase 7 session API', async () => {
    const session = await app.inject({
      method: 'POST',
      url: '/v1/playback/sessions',
      headers: auth(listener),
      payload: { trackId: retryTrackId },
    });
    expect(session.statusCode).toBe(201);
    const { hlsUrl } = session.json();
    const master = await app.inject({ method: 'GET', url: hlsUrl, headers: auth(listener) });
    expect(master.statusCode).toBe(200);
    expect(master.body).toMatch(/^#EXTM3U/);
  });

  it('a pre-existing READY track with Phase 7 HLS still plays', async () => {
    const status = await app.inject({
      method: 'GET',
      url: `/v1/tracks/${legacyReadyTrackId}/audio`,
      headers: auth(ownerArtist),
    });
    expect(status.json().audioStatus).toBe('READY');
    const session = await app.inject({
      method: 'POST',
      url: '/v1/playback/sessions',
      headers: auth(listener),
      payload: { trackId: legacyReadyTrackId },
    });
    expect(session.statusCode).toBe(201);
    const master = await app.inject({
      method: 'GET',
      url: session.json().hlsUrl,
      headers: auth(listener),
    });
    expect(master.statusCode).toBe(200);
    expect(master.body).toMatch(/^#EXTM3U/);
  });
});

// --- S3 driver (mocked client — no AWS) ----------------------------------------------

describe('S3 AudioStorage (mocked)', () => {
  it('fails fast when S3 is selected without a bucket', async () => {
    const cfg = loadConfig({ ...process.env, AUDIO_STORAGE_DRIVER: 's3' });
    await expect(createAudioStorage(cfg)).rejects.toThrow(/S3_BUCKET/);
  });

  it('maps put/get/stat/delete/copy to S3 commands with the configured prefix', async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const fakeClient = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'HeadObjectCommand' || cmd.constructor.name === 'GetObjectCommand') {
          const err = new Error('not found') as Error & { name: string };
          err.name = 'NotFound';
          throw err;
        }
        return {};
      },
    };
    const s3 = new S3Storage(fakeClient as unknown as S3ClientType, {
      bucket: 'music-bucket',
      region: 'ca-central-1',
      prefix: 'prod',
    });

    expect(await s3.exists('tracks/t1/hls/master.m3u8')).toBe(false);
    expect(await s3.getObject('tracks/t1/hls/master.m3u8')).toBeNull();
    expect(await s3.stat('tracks/t1/hls/master.m3u8')).toBeNull();
    await s3.putObject('tracks/t1/hls/master.m3u8', Buffer.from('x'), {
      contentType: 'application/x-mpegURL',
    });
    await s3.deleteObject('tracks/t1/hls/old.ts');
    await s3.copyObject('tracks/t1/hls-staging/master.m3u8', 'tracks/t1/hls/master.m3u8');

    const byName = (n: string) => sent.filter((c) => c.name === n).map((c) => c.input);
    expect(byName('HeadObjectCommand')[0]).toMatchObject({
      Bucket: 'music-bucket',
      Key: 'prod/tracks/t1/hls/master.m3u8',
    });
    expect(byName('PutObjectCommand')[0]).toMatchObject({
      Bucket: 'music-bucket',
      Key: 'prod/tracks/t1/hls/master.m3u8',
      ContentType: 'application/x-mpegURL',
    });
    expect(byName('DeleteObjectCommand')[0]).toMatchObject({
      Bucket: 'music-bucket',
      Key: 'prod/tracks/t1/hls/old.ts',
    });
    expect(byName('CopyObjectCommand')[0]).toMatchObject({
      Bucket: 'music-bucket',
      Key: 'prod/tracks/t1/hls/master.m3u8',
      CopySource: 'music-bucket/prod/tracks/t1/hls-staging/master.m3u8',
    });
  });

  it('signs private URLs locally without any network', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client({
      region: 'ca-central-1',
      credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
    });
    const s3 = new S3Storage(client, { bucket: 'music-bucket', region: 'ca-central-1', prefix: '' });
    const url = await s3.createSignedUrl!('tracks/t1/source/x.wav', 60);
    expect(url).toMatch(
      /^https:\/\/music-bucket\.s3\.ca-central-1\.amazonaws\.com\/tracks\/t1\/source\/x\.wav\?/,
    );
    expect(url).toContain('X-Amz-Expires=60');
    expect(url).toContain('X-Amz-Signature=');
  });
});
