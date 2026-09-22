// Phase 25 — offline storage layout. All audio lives in app-private
// documentDirectory and is NEVER written to public media directories or
// the system music library. No DRM is applied (ADR-019): app-private
// storage is not copy protection, it just keeps other apps' fingers out.

import * as FileSystem from 'expo-file-system/legacy';

function documentDir(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error('File system is not available on this device.');
  }
  return dir;
}

/** Root of all offline content: <documentDirectory>/offline/ */
export function offlineRoot(): string {
  return `${documentDir()}offline/`;
}

/** Per-track directory: <root>/tracks/<trackId>/ */
export function trackDir(trackId: string): string {
  return `${offlineRoot()}tracks/${trackId}/`;
}

/** The assembled, playable audio file (MPEG-TS concatenated segments). */
export function audioFile(trackId: string): string {
  return `${trackDir(trackId)}audio.ts`;
}

/** In-progress download target. Never playable: only `audio.ts` is. */
export function partFile(trackId: string): string {
  return `${trackDir(trackId)}audio.ts.part`;
}

export async function ensureTrackDir(trackId: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(trackDir(trackId), { intermediates: true });
}

export async function fileExists(uri: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists;
}

export async function fileSize(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && typeof info.size === 'number' ? info.size : 0;
}

export async function deleteTrackDir(trackId: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(trackDir(trackId));
  if (info.exists) {
    await FileSystem.deleteAsync(trackDir(trackId), { idempotent: true });
  }
}

async function dirSize(uri: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(uri);
  } catch {
    return 0;
  }
  for (const name of names) {
    const child = `${uri}${name}`;
    const info = await FileSystem.getInfoAsync(child);
    if (!info.exists) continue;
    if (info.isDirectory) {
      total += await dirSize(`${child}/`);
    } else if (typeof info.size === 'number') {
      total += info.size;
    }
  }
  return total;
}

/** Bytes used by all offline content. */
export async function offlineStorageUsage(): Promise<number> {
  return dirSize(offlineRoot());
}

/** Bytes used by one track's offline content. */
export async function trackStorageUsage(trackId: string): Promise<number> {
  return dirSize(trackDir(trackId));
}

export async function freeDiskSpace(): Promise<number> {
  return FileSystem.getFreeDiskStorageAsync();
}
