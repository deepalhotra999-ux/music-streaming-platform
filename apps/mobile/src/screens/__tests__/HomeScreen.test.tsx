// Phase 6 — HomeScreen tests: sections render from the catalog API, rails
// fail independently, and see-all navigates to the list routes.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { useAuth } from '../../auth';
import { HomeScreen } from '../HomeScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

// Phase 9 — HomeScreen now drives playback through useQueueActions. The
// hook is stubbed here; engine behavior is covered by the playback tests.
const mockPlayTracks = jest.fn();
const mockAddToQueue = jest.fn();
jest.mock('../../player', () => ({
  useQueueActions: () => ({ playTracks: mockPlayTracks, addToQueue: mockAddToQueue }),
}));

const mockUseAuth = useAuth as jest.Mock;

function pageOf<T>(items: T[]): {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
} {
  return {
    data: items,
    pagination: { page: 1, limit: 20, total: items.length, totalPages: 1 },
  };
}

const album = {
  id: 'al1',
  title: 'Afterglow',
  artistId: 'a1',
  artistName: 'Neon Bloom',
  albumType: 'ALBUM',
  coverArtUrl: null,
  releaseDate: '2024-01-01T00:00:00.000Z',
  trackCount: 8,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const artist = {
  id: 'a1',
  name: 'Neon Bloom',
  verified: true,
  followerCount: 9001,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const track1 = {
  id: 't1',
  title: 'First Light',
  artistId: 'a1',
  artistName: 'Neon Bloom',
  albumId: 'al1',
  albumTitle: 'Afterglow',
  durationMs: 180_000,
  trackNumber: 1,
  discNumber: 1,
  status: 'READY',
  playCount: 10,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const track2 = {
  ...track1,
  id: 't2',
  title: 'Second Wave',
  trackNumber: 2,
};

function mockApi(overrides: Record<string, unknown> = {}) {
  const get = jest.fn(async (path: string) => {
    if (path in overrides) {
      const value = overrides[path];
      if (value instanceof Error) {
        throw value;
      }
      return value;
    }
    if (path.startsWith('/v1/albums')) return pageOf([album]);
    if (path.startsWith('/v1/artists')) return pageOf([artist]);
    if (path.startsWith('/v1/tracks')) return pageOf([]);
    if (path.startsWith('/v1/playlists')) return pageOf([]);
    if (path.startsWith('/v1/genres')) return pageOf([]);
    throw new Error(`unexpected path ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { get } });
  return get;
}

describe('HomeScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders each catalog section from the API', async () => {
    mockApi();
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText('Afterglow')).toBeTruthy());
    expect(screen.getByText('Neon Bloom')).toBeTruthy();
    expect(screen.getByText('New releases')).toBeTruthy();
    expect(screen.getByText('Artists')).toBeTruthy();
    expect(screen.getByText('Featured playlists')).toBeTruthy();
    expect(screen.getByText('Browse genres')).toBeTruthy();
  });

  it('shows an inline retry for a failing rail while others render', async () => {
    mockApi({ '/v1/albums?limit=10': new Error('offline') });
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText('Neon Bloom')).toBeTruthy());
    // The albums rail failed: the inline error offers a tap-to-retry.
    expect(screen.getByText(/Tap to retry\./)).toBeTruthy();
    // The artists rail still rendered its items.
    expect(screen.getAllByText('Neon Bloom').length).toBeGreaterThan(0);
  });

  it('navigates to the list routes from section headers', async () => {
    mockApi();
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByText('Afterglow')).toBeTruthy());
    // SectionHeader renders "See all" next to each title.
    const seeAll = screen.getAllByText('See all');
    expect(seeAll.length).toBeGreaterThan(0);
    fireEvent.press(seeAll[0]);
    expect((router.push as jest.Mock)).toHaveBeenCalledWith('/albums');
  });

  // Phase 9 — tapping a recent track plays the rail from that track.
  it('plays the recent-tracks rail from the tapped track', async () => {
    mockApi({ '/v1/tracks?limit=5': pageOf([track1, track2]) });
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId('track-row-t2')).toBeTruthy());
    fireEvent.press(screen.getByTestId('track-row-t2'));
    expect(mockPlayTracks).toHaveBeenCalledWith([track1, track2], 1);
  });

  it('adds a recent track to the queue on long press', async () => {
    mockApi({ '/v1/tracks?limit=5': pageOf([track1, track2]) });
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId('track-row-t1')).toBeTruthy());
    fireEvent(screen.getByTestId('track-row-t1'), 'longPress');
    expect(mockAddToQueue).toHaveBeenCalledWith(track1);
  });
});
