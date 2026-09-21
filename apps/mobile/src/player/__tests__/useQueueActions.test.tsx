// Phase 9 — useQueueActions tests: queue construction and delegation to
// the engine, via a probe component (this RNTL version has no renderHook).

import { act, render } from '@testing-library/react-native';
import type { TrackSummary } from '../../api';
import type { QueueTrack } from '../../playback/types';
import { toQueueTrack } from '../../playback/types';
import { useQueueActions, type QueueActions } from '../useQueueActions';

const mockSetQueue = jest.fn<Promise<void>, [queue: QueueTrack[], startIndex?: number]>();
const mockEnqueue = jest.fn<Promise<void>, [track: QueueTrack]>();

jest.mock('../../playback', () => ({
  usePlayback: () => ({ setQueue: mockSetQueue, enqueue: mockEnqueue }),
}));

const summaries: TrackSummary[] = [
  {
    id: 't1', title: 'First Light', durationMs: 180_000, status: 'READY',
    artistId: 'a1', artistName: 'Neon Bloom', albumId: 'al1', albumTitle: 'Afterglow',
  },
  {
    id: 't2', title: 'Second Wave', durationMs: 210_000, status: 'READY',
    artistId: 'a1', artistName: 'Neon Bloom', albumId: 'al1', albumTitle: 'Afterglow',
  },
];

let captured: QueueActions | null = null;
function Probe() {
  captured = useQueueActions();
  return null;
}

describe('useQueueActions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    captured = null;
    render(<Probe />);
  });

  it('builds the queue and starts at the tapped index', async () => {
    await act(async () => {
      await captured!.playTracks(summaries, 1);
    });
    expect(mockSetQueue).toHaveBeenCalledTimes(1);
    const [queue, startIndex] = mockSetQueue.mock.calls[0] as [QueueTrack[], number];
    expect(queue).toEqual(summaries.map(toQueueTrack));
    expect(startIndex).toBe(1);
  });

  it('defaults to the first track', async () => {
    await act(async () => {
      await captured!.playTracks(summaries);
    });
    expect(mockSetQueue.mock.calls[0][1]).toBe(0);
  });

  it('clamps an out-of-range start index', async () => {
    await act(async () => {
      await captured!.playTracks(summaries, 99);
    });
    expect(mockSetQueue.mock.calls[0][1]).toBe(1);
  });

  it('ignores an empty track list', async () => {
    await act(async () => {
      await captured!.playTracks([]);
    });
    expect(mockSetQueue).not.toHaveBeenCalled();
  });

  it('appends a mapped track via addToQueue', async () => {
    await act(async () => {
      await captured!.addToQueue(summaries[0]);
    });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith(toQueueTrack(summaries[0]));
  });
});
