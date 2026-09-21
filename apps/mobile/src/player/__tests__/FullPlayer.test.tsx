// Phase 9 — FullPlayerView tests: metadata, states, transport wiring,
// seek, queue actions, and minimize.

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { QueueTrack } from '../../playback';
import { FullPlayerView } from '../FullPlayer';

const tracks: QueueTrack[] = [
  { trackId: 't1', title: 'First Light', artistName: 'Neon Bloom', albumTitle: 'Afterglow', albumId: 'al1', artworkUrl: null, durationMs: 180_000 },
  { trackId: 't2', title: 'Second Wave', artistName: 'Neon Bloom', albumTitle: 'Afterglow', albumId: 'al1', artworkUrl: null, durationMs: 210_000 },
];

function renderView(overrides = {}) {
  const props = {
    track: tracks[0],
    state: 'playing' as const,
    positionMs: 65_000,
    durationMs: 180_000,
    queue: tracks,
    trackIndex: 0,
    canNext: true,
    canPrevious: false,
    shuffle: false,
    repeatMode: 'off' as const,
    error: null as string | null,
    onToggle: jest.fn(),
    onNext: jest.fn(),
    onPrevious: jest.fn(),
    onSeek: jest.fn(),
    onToggleShuffle: jest.fn(),
    onCycleRepeat: jest.fn(),
    onPlayAt: jest.fn(),
    onRemoveAt: jest.fn(),
    onRetry: jest.fn(),
    onMinimize: jest.fn(),
    ...overrides,
  };
  render(<FullPlayerView {...props} />);
  return props;
}

describe('FullPlayerView', () => {
  it('renders track title, artist, and elapsed/total time', () => {
    renderView();
    expect(screen.getByTestId('full-player-title')).toHaveTextContent('First Light');
    expect(screen.getByTestId('full-player-artist')).toHaveTextContent('Neon Bloom');
    expect(screen.getByTestId('full-player-position')).toHaveTextContent('1:05');
    expect(screen.getByTestId('full-player-duration')).toHaveTextContent('3:00');
  });

  it('falls back to the catalog duration before the player reports one', () => {
    renderView({ durationMs: 0 });
    expect(screen.getByTestId('full-player-duration')).toHaveTextContent('3:00');
  });

  it('wires transport, shuffle, and repeat callbacks', () => {
    const props = renderView();
    fireEvent.press(screen.getByTestId('controls-toggle'));
    fireEvent.press(screen.getByTestId('controls-next'));
    fireEvent.press(screen.getByTestId('controls-shuffle'));
    fireEvent.press(screen.getByTestId('controls-repeat'));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
    expect(props.onNext).toHaveBeenCalledTimes(1);
    expect(props.onToggleShuffle).toHaveBeenCalledTimes(1);
    expect(props.onCycleRepeat).toHaveBeenCalledTimes(1);
  });

  it('shows the error banner with retry in error state', () => {
    const props = renderView({ state: 'error', error: 'network failed' });
    expect(screen.getByTestId('full-player-error')).toBeTruthy();
    expect(screen.getByText('network failed')).toBeTruthy();
    fireEvent.press(screen.getByTestId('full-player-retry'));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows a loading indicator while the session is minted', () => {
    renderView({ state: 'loading' });
    expect(screen.getByTestId('full-player-loading')).toBeTruthy();
  });

  it('forwards seek commits to onSeek', () => {
    const props = renderView();
    const seek = screen.getByTestId('full-player-seek');
    act(() => {
      seek.props.onLayout({ nativeEvent: { layout: { width: 200 } } });
    });
    act(() => {
      seek.props.onTouchStart({ nativeEvent: { locationX: 100 } });
    });
    act(() => {
      seek.props.onTouchEnd({ nativeEvent: { locationX: 100 } });
    });
    expect(props.onSeek).toHaveBeenCalledWith(90_000);
  });

  it('plays and removes queue items', () => {
    const props = renderView();
    fireEvent.press(screen.getByTestId('queue-row-1'));
    expect(props.onPlayAt).toHaveBeenCalledWith(1);
    fireEvent.press(screen.getByTestId('queue-remove-1'));
    expect(props.onRemoveAt).toHaveBeenCalledWith(1);
  });

  it('minimizes via the chevron', () => {
    const props = renderView();
    fireEvent.press(screen.getByTestId('full-player-minimize'));
    expect(props.onMinimize).toHaveBeenCalledTimes(1);
  });
});
