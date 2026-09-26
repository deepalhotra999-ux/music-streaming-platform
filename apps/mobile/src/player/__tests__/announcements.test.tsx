// Phase 31 — announcement hook tests.
//
// Verifies that meaningful async state changes (track changes, playback
// errors, download completions/failures) are announced to screen readers.

import { AccessibilityInfo } from 'react-native';
import { render } from '@testing-library/react-native';
import { usePlaybackAnnouncements } from '../usePlaybackAnnouncements';
import { usePlayback } from '../../playback';
import type { QueueTrack } from '../../playback';

jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});

jest.mock('../../playback', () => ({
  usePlayback: jest.fn(),
}));

const mockedUsePlayback = usePlayback as jest.Mock;

const trackA: QueueTrack = {
  trackId: 't1',
  title: 'First Light',
  artistName: 'Neon Bloom',
  albumTitle: 'Afterglow',
  albumId: 'al1',
  artworkUrl: null,
  durationMs: 180_000,
};

const trackB: QueueTrack = {
  ...trackA,
  trackId: 't2',
  title: 'Second Wave',
};

function mockPlayback(overrides = {}) {
  mockedUsePlayback.mockReturnValue({
    track: trackA,
    state: 'playing',
    error: null,
    ...overrides,
  });
}

function TestHost() {
  usePlaybackAnnouncements();
  return null;
}

describe('usePlaybackAnnouncements', () => {
  beforeEach(() => {
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
    mockPlayback();
  });

  it('announces the first track on mount', () => {
    render(<TestHost />);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Now playing: First Light by Neon Bloom',
    );
  });

  it('announces track changes', () => {
    const { rerender } = render(<TestHost />);
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
    mockPlayback({ track: trackB });
    rerender(<TestHost />);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Now playing: Second Wave by Neon Bloom',
    );
  });

  it('does not re-announce the same track', () => {
    const { rerender } = render(<TestHost />);
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
    mockPlayback({ state: 'paused' });
    rerender(<TestHost />);
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  });

  it('announces playback errors once', () => {
    mockPlayback({ state: 'error', error: 'Network failed' });
    const { rerender } = render(<TestHost />);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Playback error: Network failed',
    );
    (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
    rerender(<TestHost />);
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalled();
  });
});
