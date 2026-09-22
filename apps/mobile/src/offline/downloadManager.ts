// Phase 25 — download manager.
//
// One track at a time per grant: authorize (server-minted, short-lived
// delivery token) → read the token-scoped HLS master → fetch every
// segment → assemble one app-private MPEG-TS file → verify → commit.
//
// "Downloaded" is shown only after the media file AND the authorization
// record are both committed and verified. Partial segments live under
// `segments/` and are never playable: only `audio.ts` is.
//
// Pause/resume is segment-granular and genuine: completed segments stay
// on disk, an interrupted segment is re-fetched, and resume continues
// from the first missing segment — including across app restarts, with
// a fresh grant (delivery tokens are never persisted).
//
// MPEG-TS segments from our pipeline share codec parameters and
// continuous timestamps, so concatenation yields a playable file.

import * as RealFileSystem from 'expo-file-system/legacy';
import type { ApiClient } from '../api';
import { apiErrorMessage } from '../api';
import { authorizeDownload, type DownloadGrant } from './api';
import { getAuthorization, removeAuthorization, saveAuthorization } from './authorizationStore';
import {
  getDownloadRecord,
  listDownloadIds,
  newDownloadRecord,
  removeDownloadRecord,
  saveDownloadRecord,
  updateDownloadRecord,
} from './metadataStore';
import type { DownloadRecord } from './types';
import { audioFile, trackDir } from './storage';
import { base64ToBytes, bytesToBase64 } from './base64';

export interface TrackMeta {
  title: string;
  artistName: string;
  albumTitle: string | null;
  durationMs: number;
}

export interface DownloadManagerOptions {
  api: ApiClient;
  /** API origin, e.g. https://api.example.com — downloadUrl is relative. */
  baseUrl: string;
  /** Bounded concurrency: at most N simultaneous downloads. */
  concurrency?: number;
  onChange?: (record: DownloadRecord) => void;
  /** Injectable for tests. */
  fs?: typeof RealFileSystem;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

type FsType = typeof RealFileSystem;

const DEFAULT_CONCURRENCY = 2;

/**
 * Storage headroom so a download never wedges the device or dies
 * mid-write: the preflight fails fast with a clear message instead.
 */
const STORAGE_HEADROOM_BYTES = 50 * 1024 * 1024;

/** Rough HLS package estimate: 128 kbps audio plus container overhead. */
function estimateDownloadBytes(durationMs: number): number {
  return Math.ceil((Math.max(0, durationMs) / 1000) * 16_000 * 1.5);
}

interface ActiveDownload {
  abort: AbortController;
  pauseRequested: boolean;
  /** Next segment index (updated as the loop progresses). */
  segmentIndex: number;
  bytesWritten: number;
}

export class DownloadManager {
  private readonly api: ApiClient;
  private readonly baseUrl: string;
  private readonly concurrency: number;
  private readonly onChange?: (record: DownloadRecord) => void;
  private readonly fs: FsType;
  private readonly fetchFn: typeof fetch;
  /** In-memory grants only — delivery tokens are never persisted. */
  private readonly grants = new Map<string, DownloadGrant>();
  private readonly active = new Map<string, ActiveDownload>();
  private pumping = false;
  private stopped = false;

  constructor(options: DownloadManagerOptions) {
    this.api = options.api;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.onChange = options.onChange;
    this.fs = options.fs ?? RealFileSystem;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private emit(record: DownloadRecord): void {
    try {
      this.onChange?.(record);
    } catch {
      // UI listeners must not break the manager.
    }
  }

  private async setStatus(
    trackId: string,
    patch: Partial<DownloadRecord>,
  ): Promise<DownloadRecord | null> {
    const updated = await updateDownloadRecord(trackId, patch);
    if (updated) this.emit(updated);
    return updated;
  }

  private segmentsDir(trackId: string): string {
    return `${trackDir(trackId)}segments/`;
  }

  private segmentFile(trackId: string, index: number): string {
    return `${this.segmentsDir(trackId)}seg-${String(index).padStart(5, '0')}.ts`;
  }

  // -- public API -----------------------------------------------------------

  /** Queue a track for download. Duplicate-safe: no-ops when already
   *  queued/downloading/paused/complete; re-queues failed/stale/unavailable. */
  async enqueue(trackId: string, meta: TrackMeta): Promise<DownloadRecord> {
    const existing = await getDownloadRecord(trackId);
    if (existing) {
      if (
        existing.status === 'queued' ||
        existing.status === 'downloading' ||
        existing.status === 'paused' ||
        existing.status === 'complete'
      ) {
        return existing;
      }
      await this.discardMedia(trackId);
      await saveDownloadRecord({ ...newDownloadRecord(trackId, meta), status: 'queued' });
    } else {
      await saveDownloadRecord({ ...newDownloadRecord(trackId, meta), status: 'queued' });
    }
    const record = (await getDownloadRecord(trackId))!;
    this.emit(record);
    void this.pump();
    return record;
  }

  /** Pause: the in-flight segment fetch is aborted; completed segments are
   *  kept and resume continues from the first missing one. */
  async pause(trackId: string): Promise<void> {
    const download = this.active.get(trackId);
    if (download) {
      download.pauseRequested = true;
      download.abort.abort();
    }
  }

  /** Resume a paused download (fresh grant if the in-memory one is gone). */
  async resume(trackId: string): Promise<void> {
    const record = await getDownloadRecord(trackId);
    if (!record || record.status !== 'paused') return;
    await this.setStatus(trackId, { status: 'queued', error: null });
    void this.pump();
  }

  /** Cancel: stop the transfer and delete partial content. */
  async cancel(trackId: string): Promise<void> {
    const download = this.active.get(trackId);
    if (download) {
      this.active.delete(trackId);
      download.abort.abort();
    }
    await this.discardMedia(trackId);
    await removeDownloadRecord(trackId);
  }

  /** Retry a failed/stale download with a fresh grant. */
  async retry(trackId: string): Promise<void> {
    const record = await getDownloadRecord(trackId);
    if (!record || (record.status !== 'failed' && record.status !== 'stale')) return;
    await this.discardMedia(trackId);
    await this.setStatus(trackId, {
      status: 'queued',
      error: null,
      resumeSegment: null,
      bytesWritten: 0,
      totalBytes: null,
    });
    void this.pump();
  }

  /** Remove a completed download: media, authorization, and metadata. */
  async remove(trackId: string): Promise<void> {
    const download = this.active.get(trackId);
    if (download) {
      this.active.delete(trackId);
      download.abort.abort();
    }
    await this.discardMedia(trackId);
    await removeAuthorization(trackId);
    await removeDownloadRecord(trackId);
    this.grants.delete(trackId);
  }

  async list(): Promise<DownloadRecord[]> {
    const ids = await listDownloadIds();
    const records: DownloadRecord[] = [];
    for (const id of ids) {
      const record = await getDownloadRecord(id);
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Stop pumping (sign-out / teardown). In-flight transfers are aborted. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const [, download] of this.active) {
      download.abort.abort();
    }
    this.active.clear();
    this.grants.clear();
  }

  // -- internals -------------------------------------------------------------

  private async discardMedia(trackId: string): Promise<void> {
    await this.fs.deleteAsync(trackDir(trackId), { idempotent: true }).catch(() => {});
    this.grants.delete(trackId);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (this.active.size < this.concurrency) {
        const next = await this.nextQueued();
        if (!next || this.stopped) break;
        // Run without awaiting: concurrency is bounded by active.size.
        void this.runDownload(next.trackId).catch(() => {});
        // Yield so runDownload registers in `active` before re-checking.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.pumping = false;
    }
  }

  private async nextQueued(): Promise<DownloadRecord | null> {
    const ids = await listDownloadIds();
    for (const id of ids) {
      if (this.active.has(id)) continue;
      const record = await getDownloadRecord(id);
      if (record && record.status === 'queued') return record;
    }
    return null;
  }

  private async fetchPlaylist(url: string, signal: AbortSignal): Promise<string[]> {
    const res = await this.fetchFn(url, { signal });
    if (!res.ok) {
      throw new Error(`Playlist fetch failed (HTTP ${res.status}).`);
    }
    const text = await res.text();
    const entries = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (entries.length === 0) {
      throw new Error('Playlist contains no entries.');
    }
    return entries;
  }

  private async runDownload(trackId: string): Promise<void> {
    const record = await getDownloadRecord(trackId);
    if (!record || record.status !== 'queued' || this.stopped) return;
    const download: ActiveDownload = {
      abort: new AbortController(),
      pauseRequested: false,
      segmentIndex: record.resumeSegment ?? 0,
      bytesWritten: record.bytesWritten,
    };
    this.active.set(trackId, download);

    try {
      await this.setStatus(trackId, { status: 'downloading', error: null });

      // 0. Storage preflight: fail fast with a clear message instead of
      //    minting a grant and dying mid-download.
      const freeBytes = await this.fs.getFreeDiskStorageAsync();
      if (freeBytes < estimateDownloadBytes(record.durationMs) + STORAGE_HEADROOM_BYTES) {
        throw new Error('Not enough free storage to download this track.');
      }

      // 1. Authorize: a fresh server-minted grant for this attempt. The
      //    grant (with its delivery token) lives in memory only.
      let grant = this.grants.get(trackId);
      if (!grant || Date.parse(grant.downloadTokenExpiresAt) <= Date.now() + 60_000) {
        grant = await authorizeDownload(this.api, trackId);
        this.grants.set(trackId, grant);
      }

      // 2. Persist the authorization record (SecureStore) before fetching:
      //    offline playback gates on this, independent of the download.
      await saveAuthorization({
        authorizationId: grant.authorizationId,
        trackId,
        audioVersion: grant.audioVersion,
        issuedAt: new Date().toISOString(),
        expiresAt: grant.expiresAt,
        revokedAt: null,
      });
      await this.setStatus(trackId, {
        authorizationId: grant.authorizationId,
        audioVersion: grant.audioVersion,
      });

      // 3. Fetch segments, skipping ones already on disk.
      const masterUrl = `${this.baseUrl}${grant.downloadUrl}`;
      const [renditionLine] = await this.fetchPlaylist(masterUrl, download.abort.signal);
      const renditionUrl = new URL(renditionLine, masterUrl).toString();
      const segmentNames = await this.fetchPlaylist(renditionUrl, download.abort.signal);
      await this.fs.makeDirectoryAsync(this.segmentsDir(trackId), { intermediates: true });

      const startIndex = record.resumeSegment ?? 0;
      let written = record.bytesWritten;
      for (let i = startIndex; i < segmentNames.length; i++) {
        if (download.pauseRequested || this.stopped) {
          await this.setStatus(trackId, {
            status: 'paused',
            resumeSegment: i,
            bytesWritten: written,
          });
          return;
        }
        download.segmentIndex = i;
        download.bytesWritten = written;
        const target = this.segmentFile(trackId, i);
        const existing = await this.fs.getInfoAsync(target);
        if (!(existing.exists && (existing as { size?: number }).size)) {
          const segmentUrl = new URL(segmentNames[i], renditionUrl).toString();
          const segRes = await this.fetchFn(segmentUrl, { signal: download.abort.signal });
          if (!segRes.ok) {
            throw new Error(`Segment fetch failed (HTTP ${segRes.status}).`);
          }
          const bytes = new Uint8Array(await segRes.arrayBuffer());
          if (bytes.length === 0) {
            throw new Error('Received an empty segment.');
          }
          await this.fs.writeAsStringAsync(target, bytesToBase64(bytes), {
            encoding: this.fs.EncodingType.Base64,
          });
          written += bytes.length;
          download.bytesWritten = written;
          await this.setStatus(trackId, { bytesWritten: written, resumeSegment: i + 1 });
        } else {
          const size = (existing as { size?: number }).size ?? 0;
          written += size;
        }
      }

      // 4. Assemble + verify + commit. Only now is the track "Downloaded".
      await this.setStatus(trackId, { status: 'verifying', resumeSegment: null });
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < segmentNames.length; i++) {
        const b64 = await this.fs.readAsStringAsync(this.segmentFile(trackId, i), {
          encoding: this.fs.EncodingType.Base64,
        });
        chunks.push(base64ToBytes(b64));
      }
      const total = chunks.reduce((n, c) => n + c.length, 0);
      if (total <= 0) {
        throw new Error('Assembled audio is empty.');
      }
      const assembled = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        assembled.set(chunk, offset);
        offset += chunk.length;
      }
      await this.fs.writeAsStringAsync(audioFile(trackId), bytesToBase64(assembled), {
        encoding: this.fs.EncodingType.Base64,
      });
      // Segments are scratch: the assembled file is the artifact.
      await this.fs.deleteAsync(this.segmentsDir(trackId), { idempotent: true }).catch(() => {});

      const committed = await this.verifyCommittedFile(trackId, assembled);
      if (!committed) {
        throw new Error('Download commit failed verification.');
      }
      await this.setStatus(trackId, {
        status: 'complete',
        bytesWritten: total,
        totalBytes: total,
        error: null,
      });
    } catch (error) {
      // Cancelled via cancel()/remove(): the entry was dropped from
      // `active` before aborting — leave the (removed) record alone.
      if (!this.active.has(trackId) && !download.pauseRequested) {
        return;
      }
      // Paused or stopped mid-flight: persist progress so resume continues
      // from the first missing segment; never report this as a failure.
      if (download.pauseRequested || this.stopped) {
        await this.setStatus(trackId, {
          status: 'paused',
          resumeSegment: download.segmentIndex,
          bytesWritten: download.bytesWritten,
        });
        return;
      }
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'Download interrupted.'
          : apiErrorMessage(error);
      await this.setStatus(trackId, { status: 'failed', error: message });
    } finally {
      this.active.delete(trackId);
      void this.pump();
    }
  }

  /**
   * Verify the committed artifact: the file exists, decodes byte-for-byte
   * to exactly what was assembled, and the authorization record is still
   * present. Comparison is on decoded bytes, not on-disk size, because
   * the file is stored base64-encoded.
   */
  private async verifyCommittedFile(trackId: string, expected: Uint8Array): Promise<boolean> {
    try {
      const info = await this.fs.getInfoAsync(audioFile(trackId));
      if (!info.exists) return false;
      const stored = await this.fs.readAsStringAsync(audioFile(trackId), {
        encoding: this.fs.EncodingType.Base64,
      });
      const decoded = base64ToBytes(stored);
      if (decoded.length !== expected.length) return false;
      for (let i = 0; i < decoded.length; i++) {
        if (decoded[i] !== expected[i]) return false;
      }
      return (await getAuthorization(trackId)) !== null;
    } catch {
      return false;
    }
  }
}
