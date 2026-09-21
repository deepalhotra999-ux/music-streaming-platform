// Phase 13 — ArtistAlbumsScreen: own-album list, create/edit form with
// validation, and delete with confirmation.

import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useAuth } from '../../auth';
import { ArtistAlbumsScreen } from '../ArtistAlbumsScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;

function pageOf<T>(items: T[]) {
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
  releaseDate: '2026-01-01T00:00:00.000Z',
  coverArtUrl: null,
  trackCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function mockApi() {
  const get = jest.fn(async (path: string) => {
    if (path === '/v1/me/artists') return pageOf([{ id: 'a1', name: 'Neon Bloom' }]);
    if (path.startsWith('/v1/albums')) return pageOf([album]);
    throw new Error(`unexpected path ${path}`);
  });
  const post = jest.fn(async () => album);
  const patch = jest.fn(async () => album);
  const del = jest.fn(async () => undefined);
  mockUseAuth.mockReturnValue({ api: { get, post, patch, delete: del } });
  return { get, post, patch, del };
}

let alertButtons: { text?: string; onPress?: () => void }[] = [];
function pressAlertButton(text: string) {
  const button = alertButtons.find((b) => b.text === text);
  if (!button || !button.onPress) throw new Error(`alert button "${text}" not found`);
  button.onPress();
}

describe('ArtistAlbumsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    alertButtons = [];
    jest.spyOn(Alert, 'alert').mockImplementation(((_title, _message, buttons) => {
      alertButtons = (buttons ?? []) as typeof alertButtons;
    }) as typeof Alert.alert);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lists the artist’s own albums', async () => {
    mockApi();
    render(<ArtistAlbumsScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-albums-list')).toBeTruthy());
    expect(screen.getByText('Afterglow')).toBeTruthy();
  });

  it('creates an album from the form', async () => {
    const { post } = mockApi();
    render(<ArtistAlbumsScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-albums-list')).toBeTruthy());

    fireEvent.press(screen.getByTestId('new-album-button'));
    fireEvent.changeText(screen.getByTestId('album-title'), 'Second Wave');
    fireEvent.press(screen.getByTestId('album-type-SINGLE'));
    fireEvent.changeText(screen.getByTestId('album-release-date'), '2026-05-01');
    fireEvent.press(screen.getByTestId('album-save'));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/albums', {
        title: 'Second Wave',
        artistId: 'a1',
        albumType: 'SINGLE',
        releaseDate: '2026-05-01',
        coverArtUrl: null,
      }),
    );
  });

  it('validates the album form client-side', async () => {
    const { post } = mockApi();
    render(<ArtistAlbumsScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-albums-list')).toBeTruthy());

    fireEvent.press(screen.getByTestId('new-album-button'));
    fireEvent.changeText(screen.getByTestId('album-release-date'), 'not-a-date');
    fireEvent.press(screen.getByTestId('album-save'));

    await waitFor(() => {
      expect(screen.getByText('Title is required.')).toBeTruthy();
      expect(screen.getByText('Use YYYY-MM-DD.')).toBeTruthy();
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('edits an existing album', async () => {
    const { patch } = mockApi();
    render(<ArtistAlbumsScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-albums-list')).toBeTruthy());

    const edits = screen.getAllByText('Edit');
    fireEvent.press(edits[0]);
    expect(screen.getByTestId('album-form')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('album-title'), 'Afterglow Deluxe');
    fireEvent.press(screen.getByTestId('album-save'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/v1/albums/al1', {
        title: 'Afterglow Deluxe',
        albumType: 'ALBUM',
        releaseDate: '2026-01-01',
        coverArtUrl: null,
      }),
    );
  });

  it('deletes an album after confirmation', async () => {
    const { del } = mockApi();
    render(<ArtistAlbumsScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-albums-list')).toBeTruthy());

    fireEvent.press(screen.getByTestId('album-delete-al1'));
    pressAlertButton('Delete');

    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/albums/al1'));
  });

  it('shows an error state with retry when loading fails', async () => {
    const get = jest.fn(async () => {
      throw new Error('Network down');
    });
    mockUseAuth.mockReturnValue({ api: { get } });
    render(<ArtistAlbumsScreen />);
    await waitFor(() => expect(screen.getByText('Network down')).toBeTruthy());
  });
});
