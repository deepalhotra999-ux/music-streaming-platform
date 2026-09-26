// Phase 28 — player room integration: participants get a read-only view of
// the shared queue and disabled transport, while the shared engine stays
// the only player. These pin the pure view props the room screens rely on.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { MiniPlayerView } from '../MiniPlayer';
import { PlayerControls } from '../PlayerControls';
import { QueueList } from '../QueueView';
import type { QueueTrack } from '../../playback';

const track = (id: string): QueueTrack => ({
  trackId: id,
  title: `Title ${id}`,
  artistName: 'Artist',
  albumTitle: null,
  albumId: null,
  artworkUrl: null,
  durationMs: 180_000,
});

describe('room player integration', () => {
  it('PlayerControls disables all transport when transportDisabled', () => {
    render(
      <PlayerControls
        state="playing"
        canNext
        canPrevious
        shuffle={false}
        repeatMode="off"
        transportDisabled
        onToggle={jest.fn()}
        onNext={jest.fn()}
        onPrevious={jest.fn()}
        onToggleShuffle={jest.fn()}
        onCycleRepeat={jest.fn()}
      />,
    );
    for (const testId of [
      'controls-toggle',
      'controls-next',
      'controls-previous',
      'controls-shuffle',
      'controls-repeat',
    ]) {
      expect(screen.getByTestId(testId).props.accessibilityState.disabled).toBe(true);
    }
  });

  it('PlayerControls stays interactive without transportDisabled', () => {
    const onToggle = jest.fn();
    render(
      <PlayerControls
        state="playing"
        canNext
        canPrevious
        shuffle={false}
        repeatMode="off"
        onToggle={onToggle}
        onNext={jest.fn()}
        onPrevious={jest.fn()}
        onToggleShuffle={jest.fn()}
        onCycleRepeat={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByTestId('controls-toggle'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('QueueList in readOnly hides remove actions and disables jumps', () => {
    const onPlayAt = jest.fn();
    render(
      <QueueList
        queue={[track('t1'), track('t2')]}
        trackIndex={0}
        onPlayAt={onPlayAt}
        onRemoveAt={jest.fn()}
        readOnly
      />,
    );
    expect(screen.queryByTestId('queue-remove-1')).toBeNull();
    fireEvent.press(screen.getByTestId('queue-row-1'));
    expect(onPlayAt).not.toHaveBeenCalled();
    // Rows are not buttons in read-only mode.
    expect(screen.getByTestId('queue-row-1').props.accessibilityRole).toBeUndefined();
  });

  it('QueueList without readOnly keeps jump and remove actions', () => {
    const onPlayAt = jest.fn();
    const onRemoveAt = jest.fn();
    render(
      <QueueList
        queue={[track('t1'), track('t2')]}
        trackIndex={0}
        onPlayAt={(i) => onPlayAt(i)}
        onRemoveAt={(i) => onRemoveAt(i)}
      />,
    );
    fireEvent.press(screen.getByTestId('queue-row-1'));
    expect(onPlayAt).toHaveBeenCalledWith(1);
    fireEvent.press(screen.getByTestId('queue-remove-1'));
    expect(onRemoveAt).toHaveBeenCalledWith(1);
  });

  it('MiniPlayerView shows the Room badge when inRoom', () => {
    render(
      <MiniPlayerView
        track={track('t1')}
        state="playing"
        positionMs={10_000}
        durationMs={180_000}
        inRoom
        onToggle={jest.fn()}
        onClose={jest.fn()}
        onExpand={jest.fn()}
      />,
    );
    expect(screen.getByText('Artist · Room')).toBeTruthy();
  });

  it('MiniPlayerView hides the Room badge outside rooms', () => {
    render(
      <MiniPlayerView
        track={track('t1')}
        state="playing"
        positionMs={10_000}
        durationMs={180_000}
        onToggle={jest.fn()}
        onClose={jest.fn()}
        onExpand={jest.fn()}
      />,
    );
    expect(screen.queryByText('Artist · Room')).toBeNull();
    expect(screen.getByText('Artist')).toBeTruthy();
  });
});
