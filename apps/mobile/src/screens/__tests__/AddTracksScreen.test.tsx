// Phase 11 — AddTracksScreen: already-added seeding, successful add,
// rollback on failure, filter, and pagination.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { useAuth } from '../../auth';
import { AddTracksScreen } from '../AddTracksScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../library', () => ({
  LikeButton: () => null,
}));

const mockUseAuth = useAuth as jest.Mock;

function pageOf<T>(items: T[], totalPages = 1) {
  return {
    data: items,
    pagination: { page: 1, limit: 20, total: items.length, totalPages },
  };
}

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

const track2 = {
  id: 't2',
  title: 'Second Wave',
  durationMs: 200_000,
  status: 'READY',
  artistId: 'a1',
  artistName: 'Neon Bloom',
  albumId: 'al1',
  albumTitle: 'Afterglow',
};

function mockApi(pages: Record<number, unknown[]>, totalPages: number, playlistItems: unknown[]) {
  const get = jest.fn(async (path: string) => {
    if (path.startsWith('/v1/playlists/p1')) {
      return { id: 'p1', items: playlistItems };
    }
    if (path.startsWith('/v1/tracks')) {
      const page = Number(new URL(path, 'http://x').searchParams.get('page') ?? '1');
      return { ...pageOf(pages[page] ?? []), pagination: { page, limit: 20, total: 2, totalPages } };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = jest.fn(async () => ({}));
  mockUseAuth.mockReturnValue({ api: { get, post } });
  return { get, post };
}

const playlistItemFor = (track: typeof track1) => ({
  id: `item-${track.id}`,
  trackId: track.id,
  position: 1,
  track,
});

describe('AddTracksScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  it('marks tracks already in the playlist as Added from the seeded detail', async () => {
    mockApi({ 1: [track1, track2] }, 1, [playlistItemFor(track1)]);
    render(<AddTracksScreen playlistId="p1" />);

    await waitFor(() => expect(screen.getByTestId('add-tracks-added-t1')).toBeTruthy());
    expect(screen.getByTestId('add-tracks-add-t2')).toBeTruthy();
    expect(screen.queryByTestId('add-tracks-add-t1')).toBeNull();
  });

  it('adds a track and flips the row to the Added state', async () => {
    const { post } = mockApi({ 1: [track1] }, 1, []);
    render(<AddTracksScreen playlistId="p1" />);

    await waitFor(() => expect(screen.getByTestId('add-tracks-add-t1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('add-tracks-add-t1'));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/v1/playlists/p1/tracks', { trackId: 't1' }));
    await waitFor(() => expect(screen.getByTestId('add-tracks-added-t1')).toBeTruthy());
  });

  it('rolls back to the Add state and alerts when the add fails', async () => {
    const { post } = mockApi({ 1: [track1] }, 1, []);
    post.mockRejectedValueOnce(new Error('nope'));
    const alertSpy = jest.spyOn(Alert, 'alert');
    render(<AddTracksScreen playlistId="p1" />);

    await waitFor(() => expect(screen.getByTestId('add-tracks-add-t1')).toBeTruthy());
    fireEvent.press(screen.getByTestId('add-tracks-add-t1'));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    // Optimistic badge flips back to the Add button.
    await waitFor(() => expect(screen.getByTestId('add-tracks-add-t1')).toBeTruthy());
    expect(screen.queryByTestId('add-tracks-added-t1')).toBeNull();
  });

  it('debounces the filter and passes q to the track listing', async () => {
    const { get } = mockApi({ 1: [track1] }, 1, []);
    render(<AddTracksScreen playlistId="p1" />);

    await waitFor(() => expect(screen.getByTestId('track-row-t1')).toBeTruthy());
    fireEvent.changeText(screen.getByTestId('add-tracks-search'), 'neon');

    await waitFor(() =>
      expect(get.mock.calls.some(([p]: [string]) => p.includes('q=neon'))).toBe(true),
    );
  });

  it('loads the next page when scrolled to the end', async () => {
    const { get } = mockApi({ 1: [track1], 2: [track2] }, 2, []);
    render(<AddTracksScreen playlistId="p1" />);

    await waitFor(() => expect(screen.getByTestId('track-row-t1')).toBeTruthy());
    fireEvent(screen.getByTestId('library-list'), 'onEndReached');

    await waitFor(() => expect(screen.getByTestId('track-row-t2')).toBeTruthy());
    expect(get.mock.calls.some(([p]: [string]) => p.includes('page=2'))).toBe(true);
  });
});
