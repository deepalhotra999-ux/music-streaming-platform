// Phase 6 — catalog endpoint wrappers: verify each wrapper calls the right
// Phase 4 path with the right query string. The ApiClient is mocked; these
// tests pin the contract, not the transport.

import type { ApiClient } from '../client';
import {
  getAlbum,
  getArtist,
  getGenre,
  getPlaylist,
  listAlbums,
  listArtists,
  listGenres,
  listPublicPlaylists,
  listTracks,
} from '../catalog';

function mockClient(): jest.Mocked<ApiClient> {
  return { get: jest.fn(async () => ({})) } as unknown as jest.Mocked<ApiClient>;
}

describe('catalog endpoints', () => {
  it('listArtists builds the artists path', async () => {
    const client = mockClient();
    await listArtists(client, { page: 2, limit: 10 });
    expect(client.get).toHaveBeenCalledWith('/v1/artists?page=2&limit=10');
  });

  it('listArtists passes the verified filter', async () => {
    const client = mockClient();
    await listArtists(client, { verified: true });
    expect(client.get).toHaveBeenCalledWith('/v1/artists?verified=true');
  });

  it('getArtist targets the artist detail path', async () => {
    const client = mockClient();
    await getArtist(client, 'artist-1');
    expect(client.get).toHaveBeenCalledWith('/v1/artists/artist-1');
  });

  it('listAlbums supports artist and type filters', async () => {
    const client = mockClient();
    await listAlbums(client, { page: 1, artistId: 'a1', albumType: 'EP' });
    const path = (client.get as jest.Mock).mock.calls[0][0] as string;
    expect(path.startsWith('/v1/albums?')).toBe(true);
    expect(path).toContain('artistId=a1');
    expect(path).toContain('albumType=EP');
  });

  it('getAlbum targets the album detail path', async () => {
    const client = mockClient();
    await getAlbum(client, 'album-9');
    expect(client.get).toHaveBeenCalledWith('/v1/albums/album-9');
  });

  it('listTracks supports artist, album, and genre filters', async () => {
    const client = mockClient();
    await listTracks(client, { genreId: 'g7', limit: 5 });
    const path = (client.get as jest.Mock).mock.calls[0][0] as string;
    expect(path.startsWith('/v1/tracks?')).toBe(true);
    expect(path).toContain('genreId=g7');
    expect(path).toContain('limit=5');
  });

  it('listGenres builds the genres path', async () => {
    const client = mockClient();
    await listGenres(client, { page: 1 });
    expect(client.get).toHaveBeenCalledWith('/v1/genres?page=1');
  });

  it('getGenre targets the genre detail path', async () => {
    const client = mockClient();
    await getGenre(client, 'genre-2');
    expect(client.get).toHaveBeenCalledWith('/v1/genres/genre-2');
  });

  it('listPublicPlaylists hits the public browse endpoint', async () => {
    const client = mockClient();
    await listPublicPlaylists(client, { limit: 10 });
    expect(client.get).toHaveBeenCalledWith('/v1/playlists/public?limit=10');
  });

  it('getPlaylist targets the playlist detail path', async () => {
    const client = mockClient();
    await getPlaylist(client, 'pl-3');
    expect(client.get).toHaveBeenCalledWith('/v1/playlists/pl-3');
  });

  it('omits undefined params and encodes q', async () => {
    const client = mockClient();
    await listArtists(client, { q: 'neo soul' });
    expect(client.get).toHaveBeenCalledWith('/v1/artists?q=neo+soul');
  });
});
