// Phase 13 — ArtistTracksScreen: own-track list with draft/published
// badges, create/edit form with validation, and delete confirmation.

import { Alert } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useAuth } from '../../auth';
import { ArtistTracksScreen } from '../ArtistTracksScreen';

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

const track = {
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
  createdAt: '2026-01-01T00:00:00.000Z',
};

function mockApi() {
  const get = jest.fn(async (path: string) => {
    if (path === '/v1/me/artists') return pageOf([{ id: 'a1', name: 'Neon Bloom' }]);
    if (path.startsWith('/v1/albums')) return pageOf([album]);
    if (path.startsWith('/v1/tracks')) return pageOf([track]);
    throw new Error(`unexpected path ${path}`);
  });
  const post = jest.fn(async () => track);
  const patch = jest.fn(async () => track);
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

describe('ArtistTracksScreen', () => {
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

  it('lists the artist’s own tracks with status badges', async () => {
    mockApi();
    render(<ArtistTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-tracks-list')).toBeTruthy());
    expect(screen.getByText('First Light')).toBeTruthy();
    expect(screen.getByTestId('status-badge-READY')).toBeTruthy();
  });

  it('creates a draft track from the form', async () => {
    const { post } = mockApi();
    render(<ArtistTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-tracks-list')).toBeTruthy());

    fireEvent.press(screen.getByTestId('new-track-button'));
    fireEvent.changeText(screen.getByTestId('track-title'), 'Demo Take');
    fireEvent.changeText(screen.getByTestId('track-duration'), '150');
    fireEvent.press(screen.getByTestId('track-album-al1'));
    fireEvent.press(screen.getByTestId('track-save'));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/v1/tracks', {
        title: 'Demo Take',
        artistId: 'a1',
        albumId: 'al1',
        durationMs: 150_000,
        trackNumber: null,
        isrc: null,
        status: 'PROCESSING',
      }),
    );
  });

  it('validates the track form client-side', async () => {
    const { post } = mockApi();
    render(<ArtistTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-tracks-list')).toBeTruthy());

    fireEvent.press(screen.getByTestId('new-track-button'));
    fireEvent.press(screen.getByTestId('track-save'));

    await waitFor(() => {
      expect(screen.getByText('Title is required.')).toBeTruthy();
      expect(screen.getByText('Enter a duration in seconds.')).toBeTruthy();
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('edits a track and changes its status (manual READY is pipeline-owned, so the picker offers TAKEDOWN)', async () => {
    const { patch } = mockApi();
    render(<ArtistTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-tracks-list')).toBeTruthy());

    const edits = screen.getAllByText('Edit');
    fireEvent.press(edits[0]);
    // READY is no longer offered: publishing is owned by the audio pipeline.
    expect(screen.queryByTestId('track-status-READY')).toBeNull();
    fireEvent.press(screen.getByTestId('track-status-TAKEDOWN'));
    fireEvent.press(screen.getByTestId('track-save'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/v1/tracks/t1', {
        title: 'First Light',
        albumId: 'al1',
        durationMs: 180_000,
        trackNumber: 1,
        isrc: null,
        status: 'TAKEDOWN',
      }),
    );
  });

  it('deletes a track after confirmation', async () => {
    const { del } = mockApi();
    render(<ArtistTracksScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-tracks-list')).toBeTruthy());

    fireEvent.press(screen.getByTestId('track-delete-t1'));
    pressAlertButton('Delete');

    await waitFor(() => expect(del).toHaveBeenCalledWith('/v1/tracks/t1'));
  });

  it('shows an error state with retry when loading fails', async () => {
    const get = jest.fn(async () => {
      throw new Error('Network down');
    });
    mockUseAuth.mockReturnValue({ api: { get } });
    render(<ArtistTracksScreen />);
    await waitFor(() => expect(screen.getByText('Network down')).toBeTruthy());
  });
});
