// Phase 9 — QueueList tests: current-track marking, jump, and removal.

import { fireEvent, render, screen } from '@testing-library/react-native';
import type { QueueTrack } from '../../playback';
import { QueueList } from '../QueueView';

const tracks: QueueTrack[] = [
  { trackId: 't1', title: 'First Light', artistName: 'Neon Bloom', albumTitle: 'Afterglow', albumId: 'al1', artworkUrl: null, durationMs: 180_000 },
  { trackId: 't2', title: 'Second Wave', artistName: 'Neon Bloom', albumTitle: 'Afterglow', albumId: 'al1', artworkUrl: null, durationMs: 210_000 },
  { trackId: 't3', title: 'Night Drive', artistName: 'Neon Bloom', albumTitle: 'Afterglow', albumId: 'al1', artworkUrl: null, durationMs: 195_000 },
];

describe('QueueList', () => {
  it('marks the current track and lists the rest by position', () => {
    render(<QueueList queue={tracks} trackIndex={1} onPlayAt={() => {}} onRemoveAt={() => {}} />);
    expect(screen.getByLabelText('Now playing: Second Wave')).toBeTruthy();
    expect(screen.getByLabelText('Play First Light')).toBeTruthy();
    expect(screen.getByLabelText('Play Night Drive')).toBeTruthy();
  });

  it('jumps to a queue item on press', () => {
    const onPlayAt = jest.fn();
    render(<QueueList queue={tracks} trackIndex={0} onPlayAt={onPlayAt} onRemoveAt={() => {}} />);
    fireEvent.press(screen.getByTestId('queue-row-2'));
    expect(onPlayAt).toHaveBeenCalledWith(2);
  });

  it('does not jump when the current track row is pressed', () => {
    const onPlayAt = jest.fn();
    render(<QueueList queue={tracks} trackIndex={0} onPlayAt={onPlayAt} onRemoveAt={() => {}} />);
    fireEvent.press(screen.getByTestId('queue-row-0'));
    expect(onPlayAt).not.toHaveBeenCalled();
  });

  it('removes a queue item via its remove button', () => {
    const onRemoveAt = jest.fn();
    render(<QueueList queue={tracks} trackIndex={0} onPlayAt={() => {}} onRemoveAt={onRemoveAt} />);
    fireEvent.press(screen.getByTestId('queue-remove-1'));
    expect(onRemoveAt).toHaveBeenCalledWith(1);
  });

  it('shows an empty state when the queue is empty', () => {
    render(<QueueList queue={[]} trackIndex={-1} onPlayAt={() => {}} onRemoveAt={() => {}} />);
    expect(screen.getByText('Queue is empty')).toBeTruthy();
  });
});
