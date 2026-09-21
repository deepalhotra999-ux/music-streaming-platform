// Phase 13 — ArtistDashboardScreen: profile summary, counts, albums,
// tracks with draft/published badges, the no-artist create flow, and
// loading/error states.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { useAuth } from '../../auth';
import { ArtistDashboardScreen } from '../ArtistDashboardScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;

function pageOf<T>(items: T[]) {
  return {
    data: items,
    pagination: { page: 1, limit: 10, total: items.length, totalPages: 1 },
  };
}

const artistListItem = { id: 'a1', name: 'Neon Bloom', verified: true };

const artistDetail = {
  id: 'a1',
  name: 'Neon Bloom',
  verified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  profile: {
    bio: 'Fictional synth duo.',
    imageUrl: null,
    bannerUrl: null,
    website: 'https://example.com/neon-bloom',
    socialLinks: null,
  },
  counts: { albums: 1, tracks: 2, followers: 42 },
};

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

const readyTrack = {
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

const draftTrack = {
  ...readyTrack,
  id: 't2',
  title: 'Unreleased Demo',
  status: 'PROCESSING',
  trackNumber: 2,
};

function mockApi(overrides: Record<string, unknown> = {}) {
  const get = jest.fn(async (path: string) => {
    if (path in overrides) {
      const value = overrides[path];
      if (value instanceof Error) throw value;
      return value;
    }
    if (path === '/v1/me/artists') return pageOf([artistListItem]);
    if (path === '/v1/artists/a1') return artistDetail;
    if (path.startsWith('/v1/albums')) return pageOf([album]);
    if (path.startsWith('/v1/tracks')) return pageOf([readyTrack, draftTrack]);
    throw new Error(`unexpected path ${path}`);
  });
  const post = jest.fn(async (path: string) => {
    if (path === '/v1/artists') return { ...artistDetail, name: 'Created Artist' };
    throw new Error(`unexpected post ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { get, post }, user: { id: 'u1', role: 'ARTIST' } });
  return { get, post };
}

describe('ArtistDashboardScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the profile summary, counts, albums, and tracks with status badges', async () => {
    mockApi();
    render(<ArtistDashboardScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-profile-summary')).toBeTruthy());

    expect(screen.getByText('Neon Bloom ✓')).toBeTruthy();
    expect(screen.getByTestId('artist-counts')).toHaveTextContent(
      '1 album · 2 tracks · 42 followers',
    );
    // Album rail and track list.
    expect(screen.getByText('Afterglow')).toBeTruthy();
    expect(screen.getByText('First Light')).toBeTruthy();
    expect(screen.getByText('Unreleased Demo')).toBeTruthy();
    // Draft vs published distinction.
    expect(screen.getByTestId('status-badge-READY')).toBeTruthy();
    expect(screen.getByTestId('status-badge-PROCESSING')).toBeTruthy();
  });

  it('shows the create CTA when the user has no artist profile', async () => {
    let hasArtist = false;
    const get = jest.fn(async (path: string) => {
      if (path === '/v1/me/artists') return pageOf(hasArtist ? [artistListItem] : []);
      if (path === '/v1/artists/a1') return artistDetail;
      if (path.startsWith('/v1/albums')) return pageOf([album]);
      if (path.startsWith('/v1/tracks')) return pageOf([readyTrack, draftTrack]);
      throw new Error(`unexpected path ${path}`);
    });
    const post = jest.fn(async (path: string) => {
      if (path === '/v1/artists') {
        hasArtist = true;
        return { ...artistDetail, name: 'Created Artist' };
      }
      throw new Error(`unexpected post ${path}`);
    });
    mockUseAuth.mockReturnValue({ api: { get, post }, user: { id: 'u1', role: 'ARTIST' } });

    render(<ArtistDashboardScreen />);
    await waitFor(() => expect(screen.getByText('No artist profile yet')).toBeTruthy());

    fireEvent.press(screen.getByText('Create artist profile'));
    expect(screen.getByTestId('create-artist-form')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('create-artist-name'), 'Created Artist');
    fireEvent.press(screen.getByTestId('create-artist-submit'));
    // After creation the dashboard reloads around the new artist.
    await waitFor(() => expect(screen.getByTestId('artist-profile-summary')).toBeTruthy());
    expect(post).toHaveBeenCalledWith('/v1/artists', { name: 'Created Artist' });
  });

  it('validates the artist name before creating', async () => {
    mockApi({ '/v1/me/artists': pageOf([]) });
    render(<ArtistDashboardScreen />);
    await waitFor(() => expect(screen.getByText('No artist profile yet')).toBeTruthy());

    fireEvent.press(screen.getByText('Create artist profile'));
    fireEvent.press(screen.getByTestId('create-artist-submit'));
    await waitFor(() =>
      expect(screen.getByText('Give your artist profile a name.')).toBeTruthy(),
    );
  });

  it('shows an error state with retry when loading fails', async () => {
    const { get } = mockApi({ '/v1/me/artists': new Error('Network down') });
    render(<ArtistDashboardScreen />);
    await waitFor(() => expect(screen.getByText('Network down')).toBeTruthy());

    get.mockImplementation(async (path: string) => {
      if (path === '/v1/me/artists') return pageOf([artistListItem]);
      if (path === '/v1/artists/a1') return artistDetail;
      if (path.startsWith('/v1/albums')) return pageOf([album]);
      if (path.startsWith('/v1/tracks')) return pageOf([readyTrack]);
      throw new Error(`unexpected path ${path}`);
    });
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByTestId('artist-profile-summary')).toBeTruthy());
  });

  it('navigates to the management screens', async () => {
    mockApi();
    render(<ArtistDashboardScreen />);
    await waitFor(() => expect(screen.getByTestId('artist-profile-summary')).toBeTruthy());

    fireEvent.press(screen.getByTestId('manage-profile-button'));
    expect(router.push).toHaveBeenCalledWith('/(artist)/profile');

    const seeAll = screen.getAllByText('See all');
    fireEvent.press(seeAll[0]);
    expect(router.push).toHaveBeenCalledWith('/(artist)/albums');
    fireEvent.press(seeAll[1]);
    expect(router.push).toHaveBeenCalledWith('/(artist)/tracks');
  });
});
