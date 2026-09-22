// Phase 25 — human-readable byte counts for the Downloads UI.

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** "Expires in 12d" / "Expired" style labels for the authorization window. */
export function formatExpiry(expiresAt: string | null, now: number = Date.now()): string {
  if (!expiresAt) return '';
  const diff = Date.parse(expiresAt) - now;
  if (Number.isNaN(diff) || diff <= 0) return 'Expired';
  const day = 86_400_000;
  const days = Math.floor(diff / day);
  if (days >= 1) return `Expires in ${days}d`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 1) return `Expires in ${hours}h`;
  return `Expires in ${Math.max(1, Math.floor(diff / 60_000))}m`;
}
