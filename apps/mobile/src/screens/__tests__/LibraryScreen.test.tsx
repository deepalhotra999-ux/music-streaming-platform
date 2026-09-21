// Phase 11 — LibraryScreen: the five sections render independently, each
// with its own loading/error/empty states, and see-all navigates to the
// drill-down routes.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { useAuth } from '../../auth';
import { LibraryScreen } from '../LibraryScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockPlayTracks = jest.fn();
const mockAddToQueue = jest.fn();
jest.mock('../../player', () => ({
  useQueueActions: () => ({ playTracks: mockPlayTracks, addToQueue: mockAddToQueue }),
}));

const mockPlaylistFormProps = jest.fn();
jest.mock('../../library', () => ({
  LikeButton: () => null,
  PlaylistForm: (props: unknown) => {
    mockPlaylistFormProps(props);
    return null;
  },
}));

const mockUseAuth = useAuth as jest.Mock;

function pageOf<T>(items: T[]): {
  data: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
} {
  return {
    data: items,
    pagination: { page: 1, limit: 5, total: items.length, totalPages: 1 },
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

const likeItem = { trackId: 't1', createdAt: '2026-01-01T00:00:00.000Z', track };
const historyItem = {
  id: 'h1',
  trackId: 't1',
  playedAt: '2026-09-21T10:00:00.000Z',
  progressMs: 180_000,
  completed: true,
  track,
};
const playlist = {
  id: 'pl1',
  title: 'Road trip',
  description: null,
  coverArtUrl: null,
  visibility: 'PRIVATE',
  ownerUserId: 'u1',
  ownerDisplayName: 'Test User',
  trackCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const followItem = {
  artistId: 'a1',
  createdAt: '2026-01-01T00:00:00.000Z',
  artist: { id: 'a1', name: 'Neon Bloom', verified: true },
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
    if (path.startsWith('/v1/me/likes')) return pageOf([likeItem]);
    if (path.startsWith('/v1/me/history')) return pageOf([historyItem]);
    if (path.startsWith('/v1/me/playlists')) return pageOf([playlist]);
    if (path.startsWith('/v1/me/follows')) return pageOf([followItem]);
    if (path.startsWith('/v1/playlists/public')) return pageOf([playlist]);
    throw new Error(`unexpected path ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { get }, user: { id: 'u1' } });
  return get;
}

describe('LibraryScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders all five sections with preview content', async () => {
    mockApi();
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-section-liked-content')).toBeTruthy());
    expect(screen.getByTestId('library-section-history-content')).toBeTruthy();
    expect(screen.getByTestId('library-section-mine-content')).toBeTruthy();
    expect(screen.getByTestId('library-section-followed-content')).toBeTruthy();
    expect(screen.getByTestId('library-section-public-content')).toBeTruthy();
    // Preview rows render the shared data.
    expect(screen.getAllByText('First Light').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Road trip').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Neon Bloom').length).toBeGreaterThan(0);
  });

  it('navigates to the drill-down routes from section headers', async () => {
    mockApi();
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-section-liked-content')).toBeTruthy());

    // SectionHeader renders a "See all" pressable per section; press the
    // first one (Liked tracks).
    const seeAll = screen.getAllByText('See all');
    fireEvent.press(seeAll[0]);
    expect(router.push).toHaveBeenCalledWith('/liked-tracks');
  });

  it('opens the create-playlist form from the New button', async () => {
    mockApi();
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-section-mine-content')).toBeTruthy());

    fireEvent.press(screen.getByTestId('library-new-playlist'));
    const lastProps = mockPlaylistFormProps.mock.calls.at(-1)[0] as { visible: boolean };
    expect(lastProps.visible).toBe(true);
  });

  it('shows an empty state per section when the API returns nothing', async () => {
    mockApi({
      '/v1/me/likes?limit=5': pageOf([]),
      '/v1/me/history?limit=5': pageOf([]),
      '/v1/me/playlists?limit=5': pageOf([]),
      '/v1/me/follows?limit=5': pageOf([]),
      '/v1/playlists/public?limit=5': pageOf([]),
    });
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-section-liked-empty')).toBeTruthy());
    expect(screen.getByText('No liked tracks yet')).toBeTruthy();
    expect(screen.getByTestId('library-section-history-empty')).toBeTruthy();
    expect(screen.getByTestId('library-section-mine-empty')).toBeTruthy();
    expect(screen.getByTestId('library-section-followed-empty')).toBeTruthy();
    expect(screen.getByTestId('library-section-public-empty')).toBeTruthy();
  });

  it('shows an inline error with retry when one section fails', async () => {
    mockApi({ '/v1/me/likes?limit=5': new Error('offline') });
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-section-liked-error')).toBeTruthy());
    // The other sections still render their content.
    expect(screen.getByTestId('library-section-history-content')).toBeTruthy();
    // Retry re-fires the section request.
    const get = mockUseAuth.mock.results[0].value.api.get as jest.Mock;
    const before = get.mock.calls.length;
    fireEvent.press(screen.getByText('Retry'));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  it('plays a liked track from the preview on tap', async () => {
    mockApi();
    render(<LibraryScreen />);
    await waitFor(() => expect(screen.getByTestId('library-section-liked-content')).toBeTruthy());
    // The same track appears in both the liked and history previews; the
    // first one is the liked section's row.
    fireEvent.press(screen.getAllByTestId('track-row-t1')[0]);
    expect(mockPlayTracks).toHaveBeenCalledWith([track], 0);
  });
});
