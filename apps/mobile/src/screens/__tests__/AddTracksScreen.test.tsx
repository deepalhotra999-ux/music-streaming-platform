// Phase 11 — AddTracksScreen: already-added seeding, successful add,
// rollback on failure, filter, and pagination.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { useAuth } from '../../auth';
import { ApiError } from '../../api/client';
import { AddTracksScreen } from '../AddTracksScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockAddTrack = jest.fn();
jest.mock('../../library', () => ({
  LikeButton: () => null,
  // Phase 27 — the screen consumes the collab mutation hook; tests pin the
  // returned contract here and assert call args per test.
  useCollabMutations: () => ({
    addTrack: mockAddTrack,
    removeItem: jest.fn(),
    swapItems: jest.fn(),
    setCollaboration: jest.fn(),
    notice: null,
    clearNotice: jest.fn(),
  }),
}));

// Phase 27 — online status gates collaborative adds in tests.
const onlineState = { online: true };
jest.mock('../../utils/useOnlineStatus', () => ({
  useOnlineStatus: () => onlineState.online,
}));

const mockUseAuth = useAuth as jest.Mock;

beforeEach(() => {
  onlineState.online = true;
});

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

function mockApi(
  pages: Record<number, unknown[]>,
  totalPages: number,
  playlistItems: unknown[],
  playlistSeed: Record<string, unknown> = {},
) {
  const get = jest.fn(async (path: string) => {
    if (path.startsWith('/v1/playlists/p1')) {
      return { id: 'p1', items: playlistItems, ...playlistSeed };
    }
    if (path.startsWith('/v1/tracks')) {
      const page = Number(new URL(path, 'http://x').searchParams.get('page') ?? '1');
      return {
        ...pageOf(pages[page] ?? []),
        pagination: { page, limit: 20, total: 2, totalPages },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = jest.fn(async () => ({}));
  const postWithHeaders = jest.fn(
    async (): Promise<{
      data: { id: string };
      headers: { get: (name: string) => string | null };
    }> => ({
      data: { id: 'item-new' },
      headers: { get: () => null },
    }),
  );
  mockUseAuth.mockReturnValue({ api: { get, post, postWithHeaders } });
  return { get, post, postWithHeaders };
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

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/playlists/p1/tracks', { trackId: 't1' }),
    );
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

  describe('Phase 27 — collaboration', () => {
    const collabSeed = { isCollaborative: true, revision: 5 };
    const revisionHeaders = (revision: number) => ({ get: () => String(revision) });

    it('sends expectedRevision and threads the returned revision into the next add', async () => {
      const { postWithHeaders } = mockApi({ 1: [track1, track2] }, 1, [], collabSeed);
      postWithHeaders
        .mockResolvedValueOnce({ data: { id: 'i1' }, headers: revisionHeaders(6) })
        .mockResolvedValueOnce({ data: { id: 'i2' }, headers: revisionHeaders(7) });
      render(<AddTracksScreen playlistId="p1" />);

      await waitFor(() => expect(screen.getByTestId('add-tracks-add-t1')).toBeTruthy());
      fireEvent.press(screen.getByTestId('add-tracks-add-t1'));
      await waitFor(() =>
        expect(postWithHeaders).toHaveBeenCalledWith('/v1/playlists/p1/tracks', {
          trackId: 't1',
          expectedRevision: 5,
        }),
      );

      fireEvent.press(screen.getByTestId('add-tracks-add-t2'));
      await waitFor(() =>
        expect(postWithHeaders).toHaveBeenNthCalledWith(2, '/v1/playlists/p1/tracks', {
          trackId: 't2',
          expectedRevision: 6,
        }),
      );
    });

    it('on 409: refetches, rebuilds the added set, and asks the user to retry', async () => {
      const { get, postWithHeaders } = mockApi({ 1: [track1] }, 1, [], collabSeed);
      postWithHeaders.mockRejectedValueOnce(
        new ApiError(409, { title: 'Stale revision', status: 409 }),
      );
      // Seed: empty playlist at revision 5. After the 409 the refetch sees
      // the collaborator's fresh state (t1 now present, revision 6).
      let playlistCalls = 0;
      get.mockImplementation(async (path: string) => {
        if (path.startsWith('/v1/playlists/p1')) {
          playlistCalls += 1;
          return playlistCalls === 1
            ? { id: 'p1', items: [], ...collabSeed }
            : { id: 'p1', items: [playlistItemFor(track1)], ...collabSeed, revision: 6 };
        }
        return { ...pageOf([track1]), pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
      });
      const alertSpy = jest.spyOn(Alert, 'alert');
      render(<AddTracksScreen playlistId="p1" />);

      await waitFor(() => expect(screen.getByTestId('add-tracks-add-t1')).toBeTruthy());
      fireEvent.press(screen.getByTestId('add-tracks-add-t1'));

      await waitFor(() =>
        expect(alertSpy).toHaveBeenCalledWith(
          'Playlist changed',
          expect.stringContaining('Please try adding the track again'),
        ),
      );
      // The rejected write is never shown as committed: the row reflects the
      // refetched authoritative state (t1 already added by the collaborator).
      await waitFor(() => expect(screen.getByTestId('add-tracks-added-t1')).toBeTruthy());
      expect(postWithHeaders).toHaveBeenCalledTimes(1);
    });

    it('disables collaborative adds offline', async () => {
      onlineState.online = false;
      mockApi({ 1: [track1] }, 1, [], collabSeed);
      render(<AddTracksScreen playlistId="p1" />);

      await waitFor(() => expect(screen.getByTestId('add-tracks-offline-hint')).toBeTruthy());
      const addButton = screen.getByTestId('add-tracks-add-t1');
      expect(addButton.props.accessibilityState?.disabled).toBeTruthy();
    });
  });
});
