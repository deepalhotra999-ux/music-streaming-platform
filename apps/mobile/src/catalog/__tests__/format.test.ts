// Phase 6 — catalog formatting helpers tests.

import {
  formatAlbumCount,
  formatDuration,
  formatFollowerCount,
  formatReleaseYear,
  formatTotalDuration,
  formatTrackCount,
  hueFor,
  initialFor,
  placeholderBackground,
} from '../format';

describe('formatDuration', () => {
  it('formats milliseconds as m:ss', () => {
    expect(formatDuration(214000)).toBe('3:34');
    expect(formatDuration(60000)).toBe('1:00');
    expect(formatDuration(59000)).toBe('0:59');
    expect(formatDuration(500)).toBe('0:01');
  });

  it('clamps negative input to zero', () => {
    expect(formatDuration(-100)).toBe('0:00');
  });
});

describe('formatTotalDuration', () => {
  it('formats sub-hour totals as minutes', () => {
    expect(formatTotalDuration(45 * 60000)).toBe('45 min');
  });

  it('formats hour totals with remainder', () => {
    expect(formatTotalDuration(72 * 60000)).toBe('1 h 12 min');
    expect(formatTotalDuration(120 * 60000)).toBe('2 h');
  });
});

describe('formatReleaseYear', () => {
  it('extracts the year from an ISO date-time', () => {
    expect(formatReleaseYear('2024-03-15T00:00:00.000Z')).toBe('2024');
  });

  it('returns null for nullish or invalid input', () => {
    expect(formatReleaseYear(null)).toBeNull();
    expect(formatReleaseYear(undefined)).toBeNull();
    expect(formatReleaseYear('not-a-date')).toBeNull();
  });
});

describe('initialFor', () => {
  it('uppercases the first letter', () => {
    expect(initialFor('neon bloom')).toBe('N');
  });

  it('falls back for blank titles', () => {
    expect(initialFor('   ')).toBe('•');
    expect(initialFor('')).toBe('•');
  });
});

describe('hueFor', () => {
  it('is deterministic and within the hue wheel', () => {
    const a = hueFor('artist-id-123');
    expect(a).toBe(hueFor('artist-id-123'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
  });

  it('varies across different seeds', () => {
    const hues = new Set(['a', 'b', 'c', 'd', 'e'].map(hueFor));
    expect(hues.size).toBeGreaterThan(1);
  });
});

describe('placeholderBackground', () => {
  it('builds an hsl color string', () => {
    expect(placeholderBackground(210)).toBe('hsl(210, 45%, 30%)');
  });
});

describe('count formatters', () => {
  it('pluralizes tracks, albums, and followers', () => {
    expect(formatTrackCount(1)).toBe('1 track');
    expect(formatTrackCount(12)).toBe('12 tracks');
    expect(formatTrackCount(0)).toBe('0 tracks');
    expect(formatAlbumCount(1)).toBe('1 album');
    expect(formatAlbumCount(3)).toBe('3 albums');
    expect(formatFollowerCount(1)).toBe('1 follower');
    expect(formatFollowerCount(9001)).toBe('9001 followers');
  });
});
