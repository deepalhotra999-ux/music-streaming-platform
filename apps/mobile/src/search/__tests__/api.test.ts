// Phase 12 — searchCatalog tests: query fan-out, categorization, limits,
// error propagation, and the privacy boundary (playlists are searched
// through the public endpoint only — private playlists can never surface).

import { listAlbums, listArtists, listGenres, listPublicPlaylists, listTracks } from '../../api';
import { searchCatalog } from '../api';

jest.mock('../../api', () => ({
  listArtists: jest.fn(),
  listAlbums: jest.fn(),
  listTracks: jest.fn(),
  listGenres: jest.fn(),
  listPublicPlaylists: jest.fn(),
}));

const mockListArtists = listArtists as jest.Mock;
const mockListAlbums = listAlbums as jest.Mock;
const mockListTracks = listTracks as jest.Mock;
const mockListGenres = listGenres as jest.Mock;
const mockListPublicPlaylists = listPublicPlaylists as jest.Mock;

function pageOf<T>(items: T[], total: number) {
  return {
    data: items,
    pagination: { page: 1, limit: 5, total, totalPages: Math.max(1, Math.ceil(total / 5)) },
  };
}

const artist = { id: 'a1', name: 'Neon Coastline', verified: true, followerCount: 10, createdAt: '' };
const album = {
  id: 'al1',
  title: 'Glass Horizon',
  artistId: 'a1',
  artistName: 'Neon Coastline',
  albumType: 'ALBUM',
  releaseDate: null,
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
  status: 'READY',
  playCount: 0,
  createdAt: '',
};
const genre = { id: 'g1', name: 'Electronic', description: null, trackCount: 42 };
const playlist = {
  id: 'p1',
  title: 'Evening Drive',
  description: null,
  coverArtUrl: null,
  visibility: 'PUBLIC',
  ownerUserId: 'u1',
  ownerDisplayName: 'Mia',
  trackCount: 8,
  createdAt: '',
  updatedAt: '',
};

const client = {} as never;

function mockAll() {
  mockListArtists.mockResolvedValue(pageOf([artist], 1));
  mockListAlbums.mockResolvedValue(pageOf([album], 3));
  mockListTracks.mockResolvedValue(pageOf([track], 12));
  mockListGenres.mockResolvedValue(pageOf([genre], 1));
  mockListPublicPlaylists.mockResolvedValue(pageOf([playlist], 2));
}

describe('searchCatalog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAll();
  });

  it('fans out one q query per category with the default limit', async () => {
    await searchCatalog(client, 'neon');

    for (const fn of [
      mockListArtists,
      mockListAlbums,
      mockListTracks,
      mockListGenres,
      mockListPublicPlaylists,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(client, { q: 'neon', limit: 5 });
    }
  });

  it('trims the query and forwards a custom per-category limit', async () => {
    await searchCatalog(client, '  copper  ', { limitPerCategory: 3 });

    expect(mockListTracks).toHaveBeenCalledWith(client, { q: 'copper', limit: 3 });
    expect(mockListArtists).toHaveBeenCalledWith(client, { q: 'copper', limit: 3 });
  });

  it('returns categorized items with backend totals', async () => {
    const results = await searchCatalog(client, 'e');

    expect(results.artists).toEqual({ items: [artist], total: 1 });
    expect(results.albums).toEqual({ items: [album], total: 3 });
    expect(results.tracks).toEqual({ items: [track], total: 12 });
    expect(results.genres).toEqual({ items: [genre], total: 1 });
    expect(results.playlists).toEqual({ items: [playlist], total: 2 });
  });

  it('rejects empty queries without hitting the network', async () => {
    await expect(searchCatalog(client, '   ')).rejects.toThrow('non-empty query');
    for (const fn of [
      mockListArtists,
      mockListAlbums,
      mockListTracks,
      mockListGenres,
      mockListPublicPlaylists,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('propagates endpoint errors to the caller', async () => {
    mockListTracks.mockRejectedValue(new Error('boom'));
    await expect(searchCatalog(client, 'neon')).rejects.toThrow('boom');
  });

  it('searches playlists through the public endpoint only (privacy boundary)', async () => {
    // searchCatalog imports listPublicPlaylists (/v1/playlists/public) and
    // nothing else from the playlist surface — there is no code path here
    // that could reach /v1/me/playlists or private playlist detail, so
    // private playlists can never surface in results regardless of token.
    await searchCatalog(client, 'drive');
    expect(mockListPublicPlaylists).toHaveBeenCalledTimes(1);
    expect(mockListPublicPlaylists).toHaveBeenCalledWith(client, { q: 'drive', limit: 5 });
  });
});
