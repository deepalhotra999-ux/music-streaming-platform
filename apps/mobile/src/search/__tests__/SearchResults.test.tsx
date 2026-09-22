// Phase 12 — SearchResults: categorized sections render with result-type
// headers and counts, empty categories are omitted, and row presses reach
// the right handler.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { SearchResults, type SearchResultHandlers } from '../components/SearchResults';
import { emptyResults, type CategorizedResults } from '../types';

const artist = {
  id: 'a1',
  name: 'Neon Coastline',
  verified: true,
  followerCount: 1200,
  createdAt: '',
};
const album = {
  id: 'al1',
  title: 'Glass Horizon',
  artistId: 'a1',
  artistName: 'Neon Coastline',
  albumType: 'ALBUM' as const,
  releaseDate: '2024-01-01',
  coverArtUrl: null,
  trackCount: 8,
  createdAt: '',
};
const track = {
  id: 't1',
  title: 'Copper Skyline',
  artistId: 'a1',
  artistName: 'Neon Coastline',
  albumId: 'al1',
  albumTitle: 'Glass Horizon',
  durationMs: 204_000,
  trackNumber: 1,
  discNumber: 1,
  status: 'READY' as const,
  audioStatus: 'READY' as const,
  playCount: 0,
  createdAt: '',
};
const genre = { id: 'g1', name: 'Electronic', description: null, trackCount: 42 };
const playlist = {
  id: 'p1',
  title: 'Evening Drive',
  description: null,
  coverArtUrl: null,
  visibility: 'PUBLIC' as const,
  ownerUserId: 'u1',
  ownerDisplayName: 'Mia',
  trackCount: 8,
  createdAt: '',
  updatedAt: '',
  isCollaborative: false,
  revision: 0,
};

const results: CategorizedResults = {
  ...emptyResults(),
  artists: { items: [artist], total: 7 },
  tracks: { items: [track], total: 1 },
  genres: { items: [genre], total: 2 },
};

function handlers(overrides: Partial<SearchResultHandlers> = {}): SearchResultHandlers {
  return {
    onArtistPress: jest.fn(),
    onAlbumPress: jest.fn(),
    onGenrePress: jest.fn(),
    onPlaylistPress: jest.fn(),
    onTrackPress: jest.fn(),
    onTrackLongPress: jest.fn(),
    ...overrides,
  };
}

describe('SearchResults', () => {
  it('renders one section per non-empty category with header and total', () => {
    render(<SearchResults results={results} handlers={handlers()} />);

    expect(screen.getByTestId('search-results-artists')).toBeTruthy();
    expect(screen.getByTestId('search-results-tracks')).toBeTruthy();
    expect(screen.getByTestId('search-results-genres')).toBeTruthy();
    // Empty categories are omitted entirely.
    expect(screen.queryByTestId('search-results-albums')).toBeNull();
    expect(screen.queryByTestId('search-results-playlists')).toBeNull();

    // Totals come from the backend, not the visible item count.
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('Artists')).toBeTruthy();
    expect(screen.getByText('Genres')).toBeTruthy();
  });

  it('routes artist, genre, and playlist presses to their handlers', () => {
    const h = handlers();
    const full: CategorizedResults = {
      ...results,
      playlists: { items: [playlist], total: 1 },
    };
    render(<SearchResults results={full} handlers={h} />);

    fireEvent.press(screen.getByTestId('artist-row-a1'));
    expect(h.onArtistPress).toHaveBeenCalledWith('a1');

    fireEvent.press(screen.getByTestId('genre-row-g1'));
    expect(h.onGenrePress).toHaveBeenCalledWith('g1');

    fireEvent.press(screen.getByTestId('playlist-row-p1'));
    expect(h.onPlaylistPress).toHaveBeenCalledWith('p1');
  });

  it('routes album presses to the album handler', () => {
    const h = handlers();
    const full: CategorizedResults = { ...results, albums: { items: [album], total: 1 } };
    render(<SearchResults results={full} handlers={h} />);

    fireEvent.press(screen.getByTestId('album-row-al1'));
    expect(h.onAlbumPress).toHaveBeenCalledWith('al1');
  });

  it('routes track press and long-press with the result index', () => {
    const h = handlers();
    render(<SearchResults results={results} handlers={h} />);

    fireEvent.press(screen.getByTestId('track-row-t1'));
    expect(h.onTrackPress).toHaveBeenCalledWith(0);

    fireEvent(screen.getByTestId('track-row-t1'), 'longPress');
    expect(h.onTrackLongPress).toHaveBeenCalledWith(0);
  });
});
