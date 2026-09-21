// Phase 11 — LikedTracksScreen: full-page liked list with tap-to-play,
// long-press queue, pagination via the shared footer, and refresh after
// unlike.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useAuth } from '../../auth';
import { LikedTracksScreen } from '../LikedTracksScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockPlayTracks = jest.fn();
const mockAddToQueue = jest.fn();
jest.mock('../../player', () => ({
  useQueueActions: () => ({ playTracks: mockPlayTracks, addToQueue: mockAddToQueue }),
}));

jest.mock('../../library', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pressable: P, Text: T } = require('react-native');
  return {
    LikeButton: ({ trackId, onToggled }: { trackId: string; onToggled?: (liked: boolean) => void }) => (
      <P testID={`like-button-${trackId}`} onPress={() => onToggled?.(false)}>
        <T>heart</T>
      </P>
    ),
  };
});

const mockUseAuth = useAuth as jest.Mock;

const track1 = {
  id: 't1',
  title: 'First Light',
  durationMs: 180_000,
  status: 'READY',
  artistId: 'a1',
  artistName: 'Neon Bloom',
  albumId: 'al1',
  albumTitle: 'Afterglow',
};
const track2 = { ...track1, id: 't2', title: 'Second Wave' };

function pageOf<T>(items: T[], page: number, totalPages: number) {
  return {
    data: items,
    pagination: { page, limit: 20, total: items.length * totalPages, totalPages },
  };
}

function mockApi(pages: Record<number, unknown[]>, totalPages: number) {
  const get = jest.fn(async (path: string) => {
    const m = path.match(/[?&]page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    return pageOf(
      (pages[page] ?? []).map((track) => ({
        trackId: (track as { id: string }).id,
        createdAt: '2026-01-01T00:00:00.000Z',
        track,
      })),
      page,
      totalPages,
    );
  });
  mockUseAuth.mockReturnValue({ api: { get } });
  return get;
}

describe('LikedTracksScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders liked tracks and plays from the tapped one', async () => {
    mockApi({ 1: [track1, track2] }, 1);
    render(<LikedTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('track-row-t1')).toBeTruthy());
    expect(screen.getByText('Second Wave')).toBeTruthy();

    fireEvent.press(screen.getByTestId('track-row-t2'));
    expect(mockPlayTracks).toHaveBeenCalledWith([track1, track2], 1);
  });

  it('queues a track on long-press', async () => {
    mockApi({ 1: [track1] }, 1);
    render(<LikedTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('track-row-t1')).toBeTruthy());
    fireEvent(screen.getByTestId('track-row-t1'), 'onLongPress');
    expect(mockAddToQueue).toHaveBeenCalledWith(track1);
  });

  it('loads the next page when scrolled to the end', async () => {
    const get = mockApi({ 1: [track1], 2: [track2] }, 2);
    render(<LikedTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('track-row-t1')).toBeTruthy());

    fireEvent(screen.getByTestId('library-list'), 'onEndReached');
    await waitFor(() => expect(screen.getByTestId('track-row-t2')).toBeTruthy());
    const page2Calls = get.mock.calls.filter(([p]: [string]) => p.includes('page=2'));
    expect(page2Calls.length).toBeGreaterThan(0);
  });

  it('refreshes the list after a track is unliked', async () => {
    const get = mockApi({ 1: [track1] }, 1);
    render(<LikedTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('track-row-t1')).toBeTruthy());
    const callsBefore = get.mock.calls.length;

    fireEvent.press(screen.getByTestId('like-button-t1'));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('shows the empty state when nothing is liked', async () => {
    mockApi({ 1: [] }, 0);
    render(<LikedTracksScreen />);
    await waitFor(() => expect(screen.getByText('No liked tracks yet')).toBeTruthy());
  });
});
