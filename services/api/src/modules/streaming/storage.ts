// Phase 7 — streaming. Audio storage abstraction.
// Phase 14 — added write operations (putObject / deleteObject / copyObject)
// for the artist ingestion pipeline, plus the AWS S3 driver.
//
// The API never exposes permanent public audio URLs: players fetch manifests
// and segments through session-scoped routes, and this module is the only
// code that touches the raw audio bytes. The key scheme is provider-agnostic
// so S3 + CloudFront serves the same keys as the local driver:
//
//   tracks/<trackId>/hls/master.m3u8
//   tracks/<trackId>/hls/<rendition>/index.m3u8        (e.g. rendition "128k")
//   tracks/<trackId>/hls/<rendition>/<segment>        (e.g. "seg-00000.ts")
//   tracks/<trackId>/source/<uuid>.<ext>              (private upload source;
//                                                     never served to clients)
//   tracks/<trackId>/hls-staging/...                  (transient: validated
//                                                     before promotion to hls/)
//
// Phase 14 ships the S3 driver for production. Local development keeps
// working with zero AWS configuration (driver defaults to "local").

import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Config } from '../../config.js';

export interface ByteRange {
  /** First byte to serve (inclusive). */
  start: number;
  /** Last byte to serve (inclusive), or null for "to end of object". */
  end: number | null;
}

export interface StoredObject {
  stream: NodeJS.ReadableStream;
  /** Total object size in bytes (independent of any range). */
  size: number;
  contentType: string;
}

export interface PutOptions {
  contentType: string;
  /** Known body length in bytes; when omitted, streams are buffered. */
  contentLength?: number;
}

export interface AudioStorage {
  /** Size/content-type probe without opening a byte stream. Null when absent. */
  stat(key: string): Promise<{ size: number; contentType: string } | null>;
  /** Fetch an object by key, optionally a byte range. Null when absent. */
  getObject(key: string, range?: ByteRange): Promise<StoredObject | null>;
  exists(key: string): Promise<boolean>;
  /** Store an object. Overwrites any existing object at the key. */
  putObject(key: string, body: Buffer | NodeJS.ReadableStream, options: PutOptions): Promise<void>;
  /** Delete an object. No-op when absent. */
  deleteObject(key: string): Promise<void>;
  /** Server-side copy within the same bucket/root. */
  copyObject(sourceKey: string, destKey: string): Promise<void>;
  /**
   * Presigned delivery URLs (S3 / CloudFront signed URLs). The local driver
   * does not implement it — dev playback always goes through the
   * session-scoped API routes.
   */
  createSignedUrl?(key: string, ttlSeconds: number): Promise<string>;
}

/** Key builders — the single place the on-disk/S3 layout is defined. */
export const masterKey = (trackId: string): string => `tracks/${trackId}/hls/master.m3u8`;

export const mediaPlaylistKey = (trackId: string, rendition: string): string =>
  `tracks/${trackId}/hls/${rendition}/index.m3u8`;

export const segmentKey = (trackId: string, rendition: string, segment: string): string =>
  `tracks/${trackId}/hls/${rendition}/${segment}`;

/**
 * Private key for an uploaded source file. The filename is always
 * server-generated — client filenames never reach storage (no path
 * traversal, no key injection). The extension comes from server-side
 * content sniffing, not the client.
 */
export const sourceKey = (trackId: string, ext: string): string =>
  `tracks/${trackId}/source/${randomUUID()}.${ext}`;

/** Transient staging area: validated before promotion to the hls/ layout. */
export const stagingKey = (trackId: string, relativePath: string): string =>
  `tracks/${trackId}/hls-staging/${relativePath}`;

/** Reject anything that could escape the storage root. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

export function contentTypeForKey(key: string): string {
  if (key.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (key.endsWith('.ts')) return 'video/mp2t';
  if (key.endsWith('.m4s')) return 'video/iso.segment';
  if (key.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Development driver: audio packages on the local filesystem. */
export class LocalFileStorage implements AudioStorage {
  readonly root: string;

  constructor(rootDir: string) {
    // Resolve once so relative config values behave predictably.
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Storage key escapes root: ${key}`);
    }
    return full;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async stat(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const stat = await fs.stat(this.resolve(key));
      if (!stat.isFile()) return null;
      return { size: stat.size, contentType: contentTypeForKey(key) };
    } catch {
      return null;
    }
  }

  async getObject(key: string, range?: ByteRange): Promise<StoredObject | null> {
    const full = this.resolve(key);
    const info = await this.stat(key);
    if (!info) return null;
    const stream =
      range === undefined
        ? createReadStream(full)
        : createReadStream(full, { start: range.start, end: range.end ?? undefined });
    return { stream, size: info.size, contentType: info.contentType };
  }

  async putObject(
    key: string,
    body: Buffer | NodeJS.ReadableStream,
    _options?: PutOptions,
  ): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await fs.writeFile(full, body);
    } else {
      await pipeline(body, createWriteStream(full));
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await fs.rm(this.resolve(key), { force: true });
    } catch {
      // No-op when absent.
    }
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const dest = this.resolve(destKey);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(this.resolve(sourceKey), dest);
  }
}

// --- AWS S3 driver (Phase 14) ------------------------------------------------
// Lazy imports keep the AWS SDK out of the local-dev path entirely: with
// AUDIO_STORAGE_DRIVER=local (the default) no AWS code is loaded and no
// credentials are needed.

/** The AWS SDK client type, without a hard runtime import. */
export type S3ClientType = import('@aws-sdk/client-s3').S3Client;

export interface S3StorageOptions {
  bucket: string;
  region: string;
  prefix: string;
}

/** Production driver: private S3 bucket, same key scheme as local. */
export class S3Storage implements AudioStorage {
  private readonly client: S3ClientType;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(client: S3ClientType, options: S3StorageOptions) {
    this.client = client;
    this.bucket = options.bucket;
    this.prefix = options.prefix;
  }

  /** Build an S3Driver from config. Throws a clear error when misconfigured. */
  static async fromConfig(config: Config): Promise<S3Storage> {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const s3 = config.streaming.s3;
    if (!s3.bucket) {
      throw new Error(
        'AUDIO_STORAGE_DRIVER=s3 requires S3_BUCKET to be set (see services/api/.env.example).',
      );
    }
    // Credentials come from the standard AWS chain
    // (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, shared config, or instance
    // role) — never from committed config.
    const client = new S3Client({ region: s3.region });
    return new S3Storage(client, { bucket: s3.bucket, region: s3.region, prefix: s3.prefix });
  }

  private fullKey(key: string): string {
    assertSafeKey(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async stat(key: string): Promise<{ size: number; contentType: string } | null> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return {
        size: out.ContentLength ?? 0,
        contentType: out.ContentType ?? contentTypeForKey(key),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== null;
  }

  async getObject(key: string, range?: ByteRange): Promise<StoredObject | null> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
          ...(range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : {}),
        }),
      );
      if (!out.Body) return null;
      return {
        stream: out.Body as NodeJS.ReadableStream,
        size: out.ContentLength ?? 0,
        contentType: out.ContentType ?? contentTypeForKey(key),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putObject(
    key: string,
    body: Buffer | NodeJS.ReadableStream,
    options: PutOptions,
  ): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    // The SDK needs a node Readable (or Buffer) with a known length.
    // AudioStorage callers always pass node streams; anything else is
    // buffered (bounded by the ingestion upload cap).
    let payload: Buffer | Readable;
    let length = options.contentLength;
    if (Buffer.isBuffer(body)) {
      payload = body;
      length = length ?? body.length;
    } else {
      const stream = body as unknown as Readable;
      if (length === undefined) {
        const buffered = await streamToBuffer(stream);
        payload = buffered;
        length = buffered.length;
      } else {
        payload = stream;
      }
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: payload,
        ContentType: options.contentType,
        ContentLength: length,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
    );
  }

  async copyObject(sourceKey: string, destKey: string): Promise<void> {
    const { CopyObjectCommand } = await import('@aws-sdk/client-s3');
    // CopySource must be URL-encoded; encode per segment so the key's
    // slashes survive. (Our keys are server-generated and URL-safe, but
    // this keeps the driver correct for any key.)
    const encodedSource = this.fullKey(sourceKey)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodedSource}`,
        Key: this.fullKey(destKey),
        ContentType: contentTypeForKey(destKey),
      }),
    );
  }

  /** Fulfills the Phase 7 seam: short-lived presigned GET URLs. */
  async createSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      { expiresIn: ttlSeconds },
    );
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    ((err as { name?: string }).name === 'NotFound' ||
      (err as { name?: string }).name === 'NoSuchKey')
  );
}

export function createAudioStorage(config: Config): AudioStorage | Promise<AudioStorage> {
  switch (config.streaming.audioStorageDriver) {
    case 'local':
      return new LocalFileStorage(config.streaming.audioStorageDir);
    case 's3':
      // Fail fast at startup when misconfigured (no bucket / bad region);
      // the caller awaits this branch.
      return S3Storage.fromConfig(config);
    default:
      throw new Error(`Unknown audio storage driver: ${config.streaming.audioStorageDriver}`);
  }
}
