// Phase 24 — Android Auto media-id helpers unit tests.
// Pins the JS contract to AutoMediaIds.kt: every id the native side can
// send must parse here, and foreign ids must be rejected.

import {
  AUTO_ROOT,
  albumMediaId,
  artistMediaId,
  parseAutoMediaId,
  playlistMediaId,
  trackIdFromMediaId,
  trackMediaId,
} from '../identifiers';

describe('androidauto identifiers', () => {
  test('static nodes parse as node kind', () => {
    for (const id of [
      'waveform:root',
      'waveform:home',
      'waveform:recent',
      'waveform:liked',
      'waveform:playlists',
      'waveform:artists',
      'waveform:albums',
    ]) {
      expect(parseAutoMediaId(id).kind).toBe('node');
    }
    expect(AUTO_ROOT).toBe('waveform:root');
  });

  test('builders round-trip through the parser', () => {
    expect(parseAutoMediaId(trackMediaId('t1'))).toEqual({ kind: 'track', id: 't1' });
    expect(parseAutoMediaId(albumMediaId('a1'))).toEqual({ kind: 'album', id: 'a1' });
    expect(parseAutoMediaId(playlistMediaId('p1'))).toEqual({ kind: 'playlist', id: 'p1' });
    expect(parseAutoMediaId(artistMediaId('ar1'))).toEqual({ kind: 'artist', id: 'ar1' });
  });

  test('foreign ids are rejected as unknown', () => {
    for (const id of [
      '',
      'something-else',
      'waveform:',
      'waveform:track:',
      'waveform:bogus:x',
      'other:track:1',
      null,
      undefined,
    ]) {
      expect(parseAutoMediaId(id).kind).toBe('unknown');
    }
  });

  test('trackIdFromMediaId extracts only our track ids', () => {
    expect(trackIdFromMediaId(trackMediaId('abc'))).toBe('abc');
    expect(trackIdFromMediaId(albumMediaId('abc'))).toBeNull();
    expect(trackIdFromMediaId('waveform:home')).toBeNull();
    expect(trackIdFromMediaId('foreign')).toBeNull();
  });
});
