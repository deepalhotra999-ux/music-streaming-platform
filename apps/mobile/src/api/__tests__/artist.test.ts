// Phase 13 — artist management endpoint wrappers: verify each wrapper
// calls the right Phase 4 path with the right method and body. The
// ApiClient is mocked; these tests pin the contract, not the transport.

import type { ApiClient } from '../client';
import {
  createAlbum,
  createArtist,
  createTrack,
  deleteAlbum,
  deleteArtist,
  deleteTrack,
  listMyArtists,
  updateAlbum,
  updateArtist,
  updateArtistProfile,
  updateTrack,
} from '../artist';

function mockClient(): jest.Mocked<ApiClient> {
  return {
    get: jest.fn(async () => ({})),
    post: jest.fn(async () => ({})),
    patch: jest.fn(async () => ({})),
    put: jest.fn(async () => ({})),
    delete: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<ApiClient>;
}

describe('artist management endpoints', () => {
  it('listMyArtists hits /v1/me/artists', async () => {
    const client = mockClient();
    await listMyArtists(client);
    expect(client.get).toHaveBeenCalledWith('/v1/me/artists');
  });

  it('createArtist posts the name', async () => {
    const client = mockClient();
    await createArtist(client, { name: 'New Artist' });
    expect(client.post).toHaveBeenCalledWith('/v1/artists', { name: 'New Artist' });
  });

  it('updateArtist patches the artist name', async () => {
    const client = mockClient();
    await updateArtist(client, 'artist-1', { name: 'Renamed' });
    expect(client.patch).toHaveBeenCalledWith('/v1/artists/artist-1', { name: 'Renamed' });
  });

  it('deleteArtist deletes the artist', async () => {
    const client = mockClient();
    await deleteArtist(client, 'artist-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/artists/artist-1');
  });

  it('updateArtistProfile puts the profile body', async () => {
    const client = mockClient();
    await updateArtistProfile(client, 'artist-1', {
      bio: 'Fresh bio',
      website: 'https://example.com/a',
      imageUrl: null,
    });
    expect(client.put).toHaveBeenCalledWith('/v1/artists/artist-1/profile', {
      bio: 'Fresh bio',
      website: 'https://example.com/a',
      imageUrl: null,
    });
  });

  it('createAlbum posts the album body', async () => {
    const client = mockClient();
    await createAlbum(client, {
      title: 'Debut',
      artistId: 'artist-1',
      albumType: 'ALBUM',
      releaseDate: '2026-01-01',
    });
    expect(client.post).toHaveBeenCalledWith('/v1/albums', {
      title: 'Debut',
      artistId: 'artist-1',
      albumType: 'ALBUM',
      releaseDate: '2026-01-01',
    });
  });

  it('updateAlbum patches the album', async () => {
    const client = mockClient();
    await updateAlbum(client, 'album-1', { title: 'Retitled' });
    expect(client.patch).toHaveBeenCalledWith('/v1/albums/album-1', { title: 'Retitled' });
  });

  it('deleteAlbum deletes the album', async () => {
    const client = mockClient();
    await deleteAlbum(client, 'album-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/albums/album-1');
  });

  it('createTrack posts the track body', async () => {
    const client = mockClient();
    await createTrack(client, {
      title: 'Single',
      artistId: 'artist-1',
      durationMs: 180000,
      status: 'PROCESSING',
    });
    expect(client.post).toHaveBeenCalledWith('/v1/tracks', {
      title: 'Single',
      artistId: 'artist-1',
      durationMs: 180000,
      status: 'PROCESSING',
    });
  });

  it('updateTrack patches the track', async () => {
    const client = mockClient();
    await updateTrack(client, 'track-1', { title: 'Renamed', status: 'READY' });
    expect(client.patch).toHaveBeenCalledWith('/v1/tracks/track-1', {
      title: 'Renamed',
      status: 'READY',
    });
  });

  it('deleteTrack deletes the track', async () => {
    const client = mockClient();
    await deleteTrack(client, 'track-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/tracks/track-1');
  });
});
