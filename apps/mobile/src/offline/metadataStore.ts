// Phase 25 — download state metadata in AsyncStorage.
//
// Display/state metadata ONLY (status, progress, errors). Authorization
// decisions never read this store — see authorizationStore.ts. Tampering
// here can at worst confuse the UI; it cannot extend an authorization.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DownloadRecord, DownloadStatus } from './types';

const INDEX_KEY = 'offline.downloads.index.v1';
const recordKey = (trackId: string): string => `offline.downloads.record.v1.${trackId}`;

async function readIndex(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

async function writeIndex(trackIds: string[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(trackIds));
}

export async function listDownloadIds(): Promise<string[]> {
  return readIndex();
}

export async function getDownloadRecord(trackId: string): Promise<DownloadRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(recordKey(trackId));
    if (!raw) return null;
    return JSON.parse(raw) as DownloadRecord;
  } catch {
    return null;
  }
}

export async function saveDownloadRecord(record: DownloadRecord): Promise<void> {
  const next: DownloadRecord = { ...record, updatedAt: new Date().toISOString() };
  await AsyncStorage.setItem(recordKey(record.trackId), JSON.stringify(next));
  const index = await readIndex();
  if (!index.includes(record.trackId)) {
    await writeIndex([...index, record.trackId]);
  }
}

export async function updateDownloadRecord(
  trackId: string,
  patch: Partial<DownloadRecord>,
): Promise<DownloadRecord | null> {
  const current = await getDownloadRecord(trackId);
  if (!current) return null;
  const next = { ...current, ...patch };
  await saveDownloadRecord(next);
  return next;
}

export async function removeDownloadRecord(trackId: string): Promise<void> {
  await AsyncStorage.removeItem(recordKey(trackId));
  const index = await readIndex();
  await writeIndex(index.filter((t) => t !== trackId));
}

export function newDownloadRecord(
  trackId: string,
  meta: { title: string; artistName: string; albumTitle: string | null; durationMs: number },
): DownloadRecord {
  return {
    trackId,
    title: meta.title,
    artistName: meta.artistName,
    albumTitle: meta.albumTitle,
    durationMs: meta.durationMs,
    status: 'queued',
    bytesWritten: 0,
    totalBytes: null,
    resumeSegment: null,
    authorizationId: null,
    audioVersion: null,
    error: null,
    unavailableReason: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Crash recovery: anything left in a transient state by a killed app can
 * never be trusted. Downloads resume from their persisted progress;
 * mid-verification work restarts from the queue.
 */
export async function recoverInterruptedDownloads(): Promise<DownloadRecord[]> {
  const ids = await readIndex();
  const recovered: DownloadRecord[] = [];
  for (const trackId of ids) {
    const record = await getDownloadRecord(trackId);
    if (!record) continue;
    let nextStatus: DownloadStatus | null = null;
    if (record.status === 'downloading') nextStatus = 'paused';
    else if (record.status === 'verifying') nextStatus = 'queued';
    if (nextStatus) {
      const updated = await updateDownloadRecord(trackId, {
        status: nextStatus,
        // Keep resumeSegment: completed segments stay on disk, so a
        // restart resumes from the first missing segment with a fresh grant.
        error: null,
      });
      if (updated) recovered.push(updated);
    }
  }
  return recovered;
}
