// Phase 11 — formatRelativeTime unit tests.

import { formatRelativeTime } from '../format';

const NOW = new Date('2026-09-21T12:00:00.000Z').getTime();

describe('formatRelativeTime', () => {
  it('says "just now" under a minute', () => {
    expect(formatRelativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
  });

  it('renders minutes', () => {
    expect(formatRelativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m ago');
  });

  it('renders hours', () => {
    expect(formatRelativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h ago');
  });

  it('renders days', () => {
    expect(formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d ago');
  });

  it('renders a short date after a week', () => {
    const label = formatRelativeTime(new Date(NOW - 30 * 86_400_000).toISOString(), NOW);
    expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('returns empty for an invalid date', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
