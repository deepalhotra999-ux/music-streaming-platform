// Phase 11 — FollowedArtistsScreen and RecentlyPlayedScreen: list
// rendering, navigation/playback wiring, and empty states.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { useAuth } from '../../auth';
import { FollowedArtistsScreen } from '../FollowedArtistsScreen';
import { RecentlyPlayedScreen } from '../RecentlyPlayedScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockPlayTracks = jest.fn();
const mockAddToQueue = jest.fn();
jest.mock('../../player', () => ({
  useQueueActions: () => ({ playTracks: mockPlayTracks, addToQueue: mockAddToQueue }),
}));

jest.mock('../../library', () => ({
  LikeButton: () => null,
  FollowButton: () => null,
  formatRelativeTime: () => '2h ago',
}));

const mockUseAuth = useAuth as jest.Mock;

function pageOf<T>(items: T[]) {
  return {
    data: items,
    pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 },
  };
}

const track = {
  id: 't1',
  title: 'First Light',
  durationMs: 180_000,
  status: 'READY',
  artistId: 'a1',
  artistName: 'Neon Bloom',
  albumId: 'al1',
  albumTitle: 'Afterglow',
};

const followItem = {
  artistId: 'a1',
  createdAt: '2026-01-01T00:00:00.000Z',
  artist: { id: 'a1', name: 'Neon Bloom', verified: true },
};

const historyItem = {
  id: 'h1',
  trackId: 't1',
  playedAt: '2026-09-21T10:00:00.000Z',
  progressMs: 180_000,
  completed: true,
  track,
};

function mockApi(items: unknown[]) {
  const get = jest.fn(async (path: string) => {
    if (path.startsWith('/v1/me/follows') || path.startsWith('/v1/me/history')) {
      return pageOf(items);
    }
    throw new Error(`unexpected path ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { get } });
}

describe('FollowedArtistsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists followed artists and navigates on tap', async () => {
    mockApi([followItem]);
    render(<FollowedArtistsScreen />);
    await waitFor(() => expect(screen.getByText('Neon Bloom')).toBeTruthy());
    fireEvent.press(screen.getByText('Neon Bloom'));
    expect(router.push).toHaveBeenCalledWith('/artist/a1');
  });

  it('shows the empty state when following nobody', async () => {
    mockApi([]);
    render(<FollowedArtistsScreen />);
    await waitFor(() => expect(screen.getByText('Not following anyone yet')).toBeTruthy());
  });
});

describe('RecentlyPlayedScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('plays history from the tapped track and queues on long-press', async () => {
    mockApi([historyItem]);
    render(<RecentlyPlayedScreen />);
    await waitFor(() => expect(screen.getByTestId('history-row-h1')).toBeTruthy());
    expect(screen.getByText(/Played 2h ago/)).toBeTruthy();

    fireEvent.press(screen.getByTestId('history-row-h1'));
    expect(mockPlayTracks).toHaveBeenCalledWith([track], 0);
    fireEvent(screen.getByTestId('history-row-h1'), 'onLongPress');
    expect(mockAddToQueue).toHaveBeenCalledWith(track);
  });

  it('shows the empty state when there is no history', async () => {
    mockApi([]);
    render(<RecentlyPlayedScreen />);
    await waitFor(() => expect(screen.getByText('Nothing played yet')).toBeTruthy());
  });
});
