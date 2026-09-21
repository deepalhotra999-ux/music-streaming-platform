// Phase 15 — analytics formatting helpers. Pure functions, no dependencies.

/** 999 → "999", 1200 → "1.2K", 2_500_000 → "2.5M", 1_000_000_000 → "1B". */
export function formatCompact(value: number): string {
  const n = Math.max(0, Math.floor(value));
  if (n < 1000) {
    return String(n);
  }
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  for (const [divisor, suffix] of units) {
    if (n >= divisor) {
      const scaled = n / divisor;
      const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
      return `${rounded}${suffix}`;
    }
  }
  return String(n);
}

/** "2026-09-21" → "Sep 21". Falls back to the raw string when unparseable. */
export function formatBucketDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
