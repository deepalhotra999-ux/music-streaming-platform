// Phase 11 — library endpoint wrappers: verify each wrapper calls the
// right Phase 4 path with the right method and body. The ApiClient is
// mocked; these tests pin the contract, not the transport.

import type { ApiClient } from '../client';
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  followArtist,
  likeTrack,
  listFollowedArtists,
  listHistory,
  listLikedTracks,
  listMyPlaylists,
  movePlaylistItem,
  removePlaylistItem,
  unfollowArtist,
  unlikeTrack,
  updatePlaylist,
} from '../library';

function mockClient(): jest.Mocked<ApiClient> {
  return {
    get: jest.fn(async () => ({})),
    post: jest.fn(async () => ({})),
    patch: jest.fn(async () => ({})),
    delete: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<ApiClient>;
}

describe('library endpoints', () => {
  it('listLikedTracks hits /v1/me/likes with pagination', async () => {
    const client = mockClient();
    await listLikedTracks(client, { page: 2, limit: 10 });
    expect(client.get).toHaveBeenCalledWith('/v1/me/likes?page=2&limit=10');
  });

  it('likeTrack posts the track id', async () => {
    const client = mockClient();
    await likeTrack(client, 'track-1');
    expect(client.post).toHaveBeenCalledWith('/v1/me/likes', { trackId: 'track-1' });
  });

  it('unlikeTrack deletes the like', async () => {
    const client = mockClient();
    await unlikeTrack(client, 'track-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/me/likes/track-1');
  });

  it('listFollowedArtists hits /v1/me/follows', async () => {
    const client = mockClient();
    await listFollowedArtists(client, { limit: 5 });
    expect(client.get).toHaveBeenCalledWith('/v1/me/follows?limit=5');
  });

  it('followArtist posts the artist id', async () => {
    const client = mockClient();
    await followArtist(client, 'artist-1');
    expect(client.post).toHaveBeenCalledWith('/v1/me/follows', { artistId: 'artist-1' });
  });

  it('unfollowArtist deletes the follow', async () => {
    const client = mockClient();
    await unfollowArtist(client, 'artist-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/me/follows/artist-1');
  });

  it('listHistory hits /v1/me/history with pagination', async () => {
    const client = mockClient();
    await listHistory(client, { page: 3 });
    expect(client.get).toHaveBeenCalledWith('/v1/me/history?page=3');
  });

  it('listMyPlaylists hits /v1/me/playlists', async () => {
    const client = mockClient();
    await listMyPlaylists(client, { page: 1, limit: 20 });
    expect(client.get).toHaveBeenCalledWith('/v1/me/playlists?page=1&limit=20');
  });

  it('createPlaylist posts the create body', async () => {
    const client = mockClient();
    await createPlaylist(client, { title: 'Road trip', visibility: 'PUBLIC' });
    expect(client.post).toHaveBeenCalledWith('/v1/playlists', {
      title: 'Road trip',
      visibility: 'PUBLIC',
    });
  });

  it('updatePlaylist patches title and visibility', async () => {
    const client = mockClient();
    await updatePlaylist(client, 'pl-1', { title: 'New name', visibility: 'PRIVATE' });
    expect(client.patch).toHaveBeenCalledWith('/v1/playlists/pl-1', {
      title: 'New name',
      visibility: 'PRIVATE',
    });
  });

  it('deletePlaylist deletes the playlist', async () => {
    const client = mockClient();
    await deletePlaylist(client, 'pl-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/playlists/pl-1');
  });

  it('addTrackToPlaylist posts the track id', async () => {
    const client = mockClient();
    await addTrackToPlaylist(client, 'pl-1', { trackId: 'track-9' });
    expect(client.post).toHaveBeenCalledWith('/v1/playlists/pl-1/tracks', { trackId: 'track-9' });
  });

  it('movePlaylistItem patches the new position', async () => {
    const client = mockClient();
    await movePlaylistItem(client, 'pl-1', 'item-2', 5);
    expect(client.patch).toHaveBeenCalledWith('/v1/playlists/pl-1/tracks/item-2', {
      position: 5,
    });
  });

  it('removePlaylistItem deletes the item', async () => {
    const client = mockClient();
    await removePlaylistItem(client, 'pl-1', 'item-2');
    expect(client.delete).toHaveBeenCalledWith('/v1/playlists/pl-1/tracks/item-2');
  });
});
