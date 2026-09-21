// Phase 15 — analytics formatting helpers: compact numbers and UTC
// bucket-date labels.

import { formatBucketDate, formatCompact } from '../format';

describe('formatCompact', () => {
  it('leaves small numbers alone', () => {
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(42)).toBe('42');
    expect(formatCompact(999)).toBe('999');
  });

  it('compacts thousands', () => {
    expect(formatCompact(1000)).toBe('1K');
    expect(formatCompact(1200)).toBe('1.2K');
    expect(formatCompact(15_400)).toBe('15.4K');
    expect(formatCompact(999_999)).toBe('1000K');
  });

  it('compacts millions and billions', () => {
    expect(formatCompact(1_000_000)).toBe('1M');
    expect(formatCompact(2_500_000)).toBe('2.5M');
    expect(formatCompact(1_200_000_000)).toBe('1.2B');
  });

  it('floors and clamps negatives', () => {
    expect(formatCompact(1999.9)).toBe('2K');
    expect(formatCompact(-5)).toBe('0');
  });
});

describe('formatBucketDate', () => {
  it('formats a YYYY-MM-DD bucket as "Mon D"', () => {
    expect(formatBucketDate('2026-09-21')).toBe('Sep 21');
    expect(formatBucketDate('2026-01-05')).toBe('Jan 5');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(formatBucketDate('not-a-date')).toBe('not-a-date');
  });
});
