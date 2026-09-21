// Phase 7 — streaming. Audio storage abstraction.
//
// The API never exposes permanent public audio URLs: players fetch manifests
// and segments through session-scoped routes, and this module is the only
// code that touches the raw audio bytes. The key layout is provider-agnostic
// so a future S3 + CloudFront implementation serves the same keys:
//
//   tracks/<trackId>/hls/master.m3u8
//   tracks/<trackId>/hls/<rendition>/index.m3u8        (e.g. rendition "128k")
//   tracks/<trackId>/hls/<rendition>/<segment>        (e.g. "seg-00000.ts")
//
// Phase 7 ships the local-filesystem driver for development. AWS S3 (private
// bucket, CloudFront signed URLs) slots in behind this interface later — the
// session routes keep working unchanged.

import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
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

export interface AudioStorage {
  /** Size/content-type probe without opening a byte stream. Null when absent. */
  stat(key: string): Promise<{ size: number; contentType: string } | null>;
  /** Fetch an object by key, optionally a byte range. Null when absent. */
  getObject(key: string, range?: ByteRange): Promise<StoredObject | null>;
  exists(key: string): Promise<boolean>;
  /**
   * Future seam: presigned delivery URLs (S3 / CloudFront signed URLs).
   * The local driver does not implement it — dev playback always goes
   * through the session-scoped API routes.
   */
  createSignedUrl?(key: string, ttlSeconds: number): Promise<string>;
}

/** Key builders — the single place the on-disk/S3 layout is defined. */
export const masterKey = (trackId: string): string => `tracks/${trackId}/hls/master.m3u8`;

export const mediaPlaylistKey = (trackId: string, rendition: string): string =>
  `tracks/${trackId}/hls/${rendition}/index.m3u8`;

export const segmentKey = (trackId: string, rendition: string, segment: string): string =>
  `tracks/${trackId}/hls/${rendition}/${segment}`;

/** Reject anything that could escape the storage root. */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/;

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..')) {
    throw new Error(`Unsafe storage key: ${key}`);
  }
}

function contentTypeFor(key: string): string {
  if (key.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (key.endsWith('.ts')) return 'video/mp2t';
  if (key.endsWith('.m4s')) return 'video/iso.segment';
  if (key.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
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
      return { size: stat.size, contentType: contentTypeFor(key) };
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
}

export function createAudioStorage(config: Config): AudioStorage {
  switch (config.streaming.audioStorageDriver) {
    case 'local':
      return new LocalFileStorage(config.streaming.audioStorageDir);
    case 's3':
      // Reserved seam (ADR-006). Selecting the S3 driver before the provider
      // exists fails fast at startup instead of serving broken playback URLs.
      throw new Error(
        'AUDIO_STORAGE_DRIVER=s3 is reserved for the future AWS S3 + CloudFront ' +
          'implementation and is not available yet. Use "local".',
      );
    default:
      throw new Error(
        `Unknown audio storage driver: ${config.streaming.audioStorageDriver}`,
      );
  }
}
