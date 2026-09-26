// Phase 9 — MiniPlayerHost tests: the host renders the bar exactly when
// the engine has a selected track and is not idle.

import { render, screen } from '@testing-library/react-native';
import type { QueueTrack } from '../../playback';
import { MiniPlayerHost } from '../MiniPlayerHost';

// The expo-router/safe-area mocks come from jest.setup.js; segments are
// mutable via the mock's __mockSegments array.
const mockSegments: string[] = jest.requireMock('expo-router').__mockSegments;
const mockPlaybackState: { track: QueueTrack | null; state: string } = {
  track: null,
  state: 'idle',
};

jest.mock('../../playback', () => ({
  usePlayback: () => mockPlaybackState,
}));

// Phase 28 — MiniPlayer reads useRoom; outside a room it degrades to the
// plain local toggle.
jest.mock('../../rooms', () => ({
  useRoom: () => ({ room: null, status: 'idle', isHost: false }),
}));

const track: QueueTrack = {
  trackId: 't1',
  title: 'First Light',
  artistName: 'Neon Bloom',
  albumTitle: 'Afterglow',
  albumId: 'al1',
  artworkUrl: null,
  durationMs: 180_000,
};

describe('MiniPlayerHost', () => {
  beforeEach(() => {
    mockPlaybackState.track = null;
    mockPlaybackState.state = 'idle';
    mockSegments.length = 0;
  });

  it('renders nothing without a selected track', () => {
    render(<MiniPlayerHost />);
    expect(screen.queryByTestId('mini-player-host')).toBeNull();
  });

  it('renders the bar while playing', () => {
    mockPlaybackState.track = track;
    mockPlaybackState.state = 'playing';
    render(<MiniPlayerHost />);
    expect(screen.getByTestId('mini-player-host')).toBeTruthy();
    expect(screen.getByTestId('mini-player')).toBeTruthy();
  });

  it('hides when idle even with a selected track', () => {
    mockPlaybackState.track = track;
    mockPlaybackState.state = 'idle';
    render(<MiniPlayerHost />);
    expect(screen.queryByTestId('mini-player-host')).toBeNull();
  });

  it('stays visible in error state', () => {
    mockPlaybackState.track = track;
    mockPlaybackState.state = 'error';
    render(<MiniPlayerHost />);
    expect(screen.getByTestId('mini-player-host')).toBeTruthy();
  });

  it('hides on the full-player route so the bar never covers it', () => {
    mockPlaybackState.track = track;
    mockPlaybackState.state = 'playing';
    mockSegments.push('player');
    render(<MiniPlayerHost />);
    expect(screen.queryByTestId('mini-player-host')).toBeNull();
  });

  it('sits above the tab bar on tab routes', () => {
    mockPlaybackState.track = track;
    mockPlaybackState.state = 'playing';
    mockSegments.push('(tabs)');
    render(<MiniPlayerHost />);
    const host = screen.getByTestId('mini-player-host');
    const style = Array.isArray(host.props.style)
      ? Object.assign({}, ...host.props.style)
      : host.props.style;
    // Safe-area mock insets are 0; the tab-bar offset must still apply.
    expect(style.bottom).toBeGreaterThan(0);
  });
});
