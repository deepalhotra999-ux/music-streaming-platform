// Phase 11 — MyPlaylistsScreen: the user's playlists with the real
// create-playlist form: validation, successful creation navigating to the
// new playlist, and server errors.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { useAuth } from '../../auth';
import { MyPlaylistsScreen } from '../MyPlaylistsScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../player', () => ({
  useQueueActions: () => ({ playTracks: jest.fn(), addToQueue: jest.fn() }),
}));

// Keep the real PlaylistForm so the full create flow is exercised; only
// the library context is unavailable, which this screen does not need.
const mockUseAuth = useAuth as jest.Mock;

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

function mockApi(overrides: Record<string, unknown> = {}) {
  const get = jest.fn(async (path: string) => {
    if (path.startsWith('/v1/me/playlists')) {
      return {
        data: [playlist],
        pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
      };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  const post = jest.fn(async (_path: string, body: unknown) => {
    if (overrides.post instanceof Error) {
      throw overrides.post;
    }
    return { ...playlist, id: 'pl-new', ...(body as Record<string, unknown>) };
  });
  mockUseAuth.mockReturnValue({ api: { get, post }, user: { id: 'u1' } });
  return { get, post };
}

describe('MyPlaylistsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists the user playlists and opens them on tap', async () => {
    mockApi();
    render(<MyPlaylistsScreen />);
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy());
    fireEvent.press(screen.getByTestId('my-playlist-row-pl1'));
    expect(router.push).toHaveBeenCalledWith('/playlist/pl1');
  });

  it('creates a playlist through the form and navigates to it', async () => {
    const { post } = mockApi();
    render(<MyPlaylistsScreen />);
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy());

    fireEvent.press(screen.getByTestId('my-playlists-new'));
    await waitFor(() => expect(screen.getByTestId('playlist-form-modal')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('playlist-form-title'), 'Chill evening');
    fireEvent.press(screen.getByTestId('playlist-form-submit'));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/playlists', {
        title: 'Chill evening',
        description: null,
        visibility: 'PRIVATE',
      }),
    );
    expect(router.push).toHaveBeenCalledWith('/playlist/pl-new');
  });

  it('blocks an empty title with client-side validation', async () => {
    const { post } = mockApi();
    render(<MyPlaylistsScreen />);
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy());

    fireEvent.press(screen.getByTestId('my-playlists-new'));
    await waitFor(() => expect(screen.getByTestId('playlist-form-modal')).toBeTruthy());

    fireEvent.press(screen.getByTestId('playlist-form-submit'));
    expect(screen.getByTestId('playlist-form-title-error')).toHaveTextContent(
      'Give your playlist a title.',
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('surfaces a server error without closing the form', async () => {
    mockApi({ post: new Error('title taken') });
    render(<MyPlaylistsScreen />);
    await waitFor(() => expect(screen.getByText('Road trip')).toBeTruthy());

    fireEvent.press(screen.getByTestId('my-playlists-new'));
    await waitFor(() => expect(screen.getByTestId('playlist-form-modal')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('playlist-form-title'), 'Taken name');
    fireEvent.press(screen.getByTestId('playlist-form-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('playlist-form-error')).toHaveTextContent('title taken'),
    );
    expect(screen.getByTestId('playlist-form-modal')).toBeTruthy();
  });
});
