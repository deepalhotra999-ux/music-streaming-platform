// Phase 23 — unit tests for the pure bridge-id helpers (JS mirror of the
// Swift CarPlayIdentifiers). No React Native imports: fully deterministic.

import {
  albumNodeId,
  artistNodeId,
  playlistNodeId,
  splitNodeId,
  trackIdFromItemId,
  trackItemId,
} from '../identifiers';

describe('carplay identifiers', () => {
  test('track item ids round-trip', () => {
    expect(trackItemId('abc123')).toBe('track:abc123');
    expect(trackIdFromItemId('track:abc123')).toBe('abc123');
  });

  test('trackIdFromItemId rejects non-track and malformed ids', () => {
    expect(trackIdFromItemId('node:liked')).toBeNull();
    expect(trackIdFromItemId('album-row:a1')).toBeNull();
    expect(trackIdFromItemId('track:')).toBeNull();
    expect(trackIdFromItemId('')).toBeNull();
  });

  test('node id builders', () => {
    expect(albumNodeId('a1')).toBe('album:a1');
    expect(playlistNodeId('p1')).toBe('playlist:p1');
    expect(artistNodeId('r1')).toBe('artist:r1');
  });

  test('splitNodeId', () => {
    expect(splitNodeId('album:a1')).toEqual({ base: 'album', parameter: 'a1' });
    expect(splitNodeId('home')).toEqual({ base: 'home', parameter: null });
    expect(splitNodeId('')).toBeNull();
    expect(splitNodeId('album:')).toBeNull();
    expect(splitNodeId(':a1')).toBeNull();
  });
});
