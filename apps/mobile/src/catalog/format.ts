// Phase 6 — catalog formatting helpers. Pure functions, no dependencies.

/** 214000 ms → "3:34". */
export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Sums track durations → "1 h 12 min" / "45 min" / "3 min". */
export function formatTotalDuration(durationMs: number): string {
  const totalMinutes = Math.round(durationMs / 60000);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/** ISO date-time → "2024". Null/blank → null. */
export function formatReleaseYear(isoDate: string | null | undefined): string | null {
  if (!isoDate) {
    return null;
  }
  const year = new Date(isoDate).getFullYear();
  return Number.isNaN(year) ? null : String(year);
}

/** "Neon Bloom" → "N". Falls back to "•" for blank titles. */
export function initialFor(title: string): string {
  const first = title.trim().charAt(0);
  return first ? first.toUpperCase() : '•';
}

/**
 * Deterministic hue (0–359) from a stable seed (entity id), so placeholder
 * artwork has a stable, varied color per artist/album/playlist without any
 * network fetch. djb2 hash, then fold into the hue wheel.
 */
export function hueFor(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/** Background fill for placeholder artwork at a given hue. */
export function placeholderBackground(hue: number): string {
  return `hsl(${hue}, 45%, 30%)`;
}

/** 1 → "1 track", 12 → "12 tracks". */
export function formatTrackCount(count: number): string {
  return count === 1 ? '1 track' : `${count} tracks`;
}

/** 1 → "1 album", 12 → "12 albums". */
export function formatAlbumCount(count: number): string {
  return count === 1 ? '1 album' : `${count} albums`;
}

/** 1 → "1 follower", 0/2+ → "N followers". */
export function formatFollowerCount(count: number): string {
  return count === 1 ? '1 follower' : `${count} followers`;
}
