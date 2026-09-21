// Phase 13 — ArtistProfileScreen: view/edit the artist name and the
// schema-backed profile fields, with client validation and save.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useAuth } from '../../auth';
import { ArtistProfileScreen } from '../ArtistProfileScreen';

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

function mockApi() {
  const get = jest.fn(async (path: string) => {
    if (path === '/v1/me/artists') return pageOf([{ id: 'a1', name: 'Neon Bloom' }]);
    if (path === '/v1/artists/a1') return artistDetail;
    throw new Error(`unexpected path ${path}`);
  });
  const patch = jest.fn(async () => artistDetail);
  const put = jest.fn(async () => artistDetail.profile);
  mockUseAuth.mockReturnValue({ api: { get, patch, put }, user: { id: 'u1', role: 'ARTIST' } });
  return { get, patch, put };
}

describe('ArtistProfileScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads and prefills the profile fields', async () => {
    mockApi();
    render(<ArtistProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-save')).toBeTruthy());

    expect(screen.getByTestId('profile-name')).toHaveDisplayValue('Neon Bloom');
    expect(screen.getByTestId('profile-bio')).toHaveDisplayValue('Fictional synth duo.');
    expect(screen.getByTestId('profile-website')).toHaveProp(
      'value',
      'https://example.com/neon-bloom',
    );
  });

  it('saves name and profile changes', async () => {
    const { patch, put } = mockApi();
    render(<ArtistProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-save')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('profile-name'), 'Neon Bloomers');
    fireEvent.changeText(screen.getByTestId('profile-bio'), 'Updated bio.');
    fireEvent.press(screen.getByTestId('profile-save'));

    await waitFor(() => expect(screen.getByTestId('profile-saved')).toBeTruthy());
    expect(patch).toHaveBeenCalledWith('/v1/artists/a1', { name: 'Neon Bloomers' });
    expect(put).toHaveBeenCalledWith('/v1/artists/a1/profile', {
      bio: 'Updated bio.',
      website: 'https://example.com/neon-bloom',
      imageUrl: null,
      bannerUrl: null,
    });
  });

  it('does not patch the name when it is unchanged', async () => {
    const { patch, put } = mockApi();
    render(<ArtistProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-save')).toBeTruthy());

    fireEvent.press(screen.getByTestId('profile-save'));
    await waitFor(() => expect(screen.getByTestId('profile-saved')).toBeTruthy());
    expect(patch).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalled();
  });

  it('validates the name and URLs client-side', async () => {
    const { patch, put } = mockApi();
    render(<ArtistProfileScreen />);
    await waitFor(() => expect(screen.getByTestId('profile-save')).toBeTruthy());

    fireEvent.changeText(screen.getByTestId('profile-name'), '   ');
    fireEvent.changeText(screen.getByTestId('profile-website'), 'not-a-url');
    fireEvent.press(screen.getByTestId('profile-save'));

    await waitFor(() => {
      expect(screen.getByText('Artist name is required.')).toBeTruthy();
      expect(screen.getByText('Must be a valid http(s) URL.')).toBeTruthy();
    });
    expect(patch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('shows an error state with retry when loading fails', async () => {
    const get = jest.fn(async () => {
      throw new Error('Network down');
    });
    mockUseAuth.mockReturnValue({ api: { get }, user: { id: 'u1', role: 'ARTIST' } });
    render(<ArtistProfileScreen />);
    await waitFor(() => expect(screen.getByText('Network down')).toBeTruthy());
  });
});
