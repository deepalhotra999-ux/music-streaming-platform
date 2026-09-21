// Phase 9 — MiniPlayer tests: pure view behavior plus the host's
// visibility rules.

import { fireEvent, render, screen } from '@testing-library/react-native';
import type { QueueTrack } from '../../playback';
import { MiniPlayerView } from '../MiniPlayer';
import { shouldShowMiniPlayer } from '../MiniPlayerHost';

const track: QueueTrack = {
  trackId: 't1',
  title: 'First Light',
  artistName: 'Neon Bloom',
  albumTitle: 'Afterglow',
  albumId: 'al1',
  artworkUrl: null,
  durationMs: 180_000,
};

function renderView(overrides = {}) {
  const props = {
    track,
    state: 'playing' as const,
    positionMs: 45_000,
    durationMs: 180_000,
    onToggle: jest.fn(),
    onClose: jest.fn(),
    onExpand: jest.fn(),
    ...overrides,
  };
  render(<MiniPlayerView {...props} />);
  return props;
}

describe('MiniPlayerView', () => {
  it('renders the current track title and artist', () => {
    renderView();
    expect(screen.getByText('First Light')).toBeTruthy();
    expect(screen.getByText('Neon Bloom')).toBeTruthy();
  });

  it('expands to the full player on tap', () => {
    const props = renderView();
    fireEvent.press(screen.getByTestId('mini-player-expand'));
    expect(props.onExpand).toHaveBeenCalledTimes(1);
  });

  it('toggles playback', () => {
    const props = renderView();
    fireEvent.press(screen.getByTestId('mini-player-toggle'));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('closes playback', () => {
    const props = renderView();
    fireEvent.press(screen.getByTestId('mini-player-close'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('labels the toggle Pause while playing and Play while paused', () => {
    renderView({ state: 'playing' });
    expect(screen.getByLabelText('Pause')).toBeTruthy();
  });

  it('shows the toggle as Retry in error state', () => {
    const props = renderView({ state: 'error' });
    const toggle = screen.getByTestId('mini-player-toggle');
    expect(toggle.props.accessibilityLabel).toBe('Retry');
    fireEvent.press(toggle);
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows a loading indicator while buffering', () => {
    renderView({ state: 'buffering' });
    expect(screen.getAllByTestId('mini-player-loading').length).toBeGreaterThan(0);
  });
});

describe('shouldShowMiniPlayer', () => {
  it('shows whenever a track is selected and not idle', () => {
    expect(shouldShowMiniPlayer(track, 'playing', [])).toBe(true);
    expect(shouldShowMiniPlayer(track, 'paused', ['(tabs)'])).toBe(true);
    expect(shouldShowMiniPlayer(track, 'loading', ['(catalog)'])).toBe(true);
    expect(shouldShowMiniPlayer(track, 'error', [])).toBe(true);
    expect(shouldShowMiniPlayer(track, 'ended', [])).toBe(true);
  });

  it('hides when idle or when no track is selected', () => {
    expect(shouldShowMiniPlayer(track, 'idle', [])).toBe(false);
    expect(shouldShowMiniPlayer(null, 'playing', [])).toBe(false);
    expect(shouldShowMiniPlayer(null, 'idle', [])).toBe(false);
  });

  it('hides on the full-player route', () => {
    expect(shouldShowMiniPlayer(track, 'playing', ['player'])).toBe(false);
  });
});
