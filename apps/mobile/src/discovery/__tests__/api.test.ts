// Phase 26 — discovery API wrappers: URL/body construction and error
// propagation. The ApiClient is mocked; we assert the exact paths and
// payloads the backend expects.

import type { ApiClient } from '../../api';
import {
  getEmergingArtists,
  getPlaylistCriteria,
  getRecommendations,
  queryDiscovery,
} from '../api';

function mockClient(): { client: ApiClient; get: jest.Mock; post: jest.Mock } {
  const get = jest.fn().mockResolvedValue({});
  const post = jest.fn().mockResolvedValue({});
  const client = { get, post } as unknown as ApiClient;
  return { client, get, post };
}

describe('getRecommendations', () => {
  it('calls the recommendations endpoint with encoded query params', async () => {
    const { client, get } = mockClient();
    await getRecommendations(client, { limit: 20, refresh: true });
    expect(get).toHaveBeenCalledWith('/v1/discovery/recommendations?limit=20&refresh=true');
  });

  it('omits undefined params', async () => {
    const { client, get } = mockClient();
    await getRecommendations(client, {});
    expect(get).toHaveBeenCalledWith('/v1/discovery/recommendations');
  });

  it('passes genre/artist/emerging filters', async () => {
    const { client, get } = mockClient();
    await getRecommendations(client, { genreId: 'g1', emergingOnly: true });
    expect(get).toHaveBeenCalledWith('/v1/discovery/recommendations?genreId=g1&emergingOnly=true');
  });
});

describe('queryDiscovery', () => {
  it('posts the query to the NL endpoint', async () => {
    const { client, post } = mockClient();
    await queryDiscovery(client, 'mellow evening jazz', 10);
    expect(post).toHaveBeenCalledWith('/v1/discovery/query', {
      query: 'mellow evening jazz',
      limit: 10,
    });
  });
});

describe('getEmergingArtists', () => {
  it('calls the emerging endpoint', async () => {
    const { client, get } = mockClient();
    await getEmergingArtists(client);
    expect(get).toHaveBeenCalledWith('/v1/discovery/emerging');
  });
});

describe('getPlaylistCriteria', () => {
  it('posts criteria request without creating anything', async () => {
    const { client, post } = mockClient();
    await getPlaylistCriteria(client, { query: 'workout energy', limit: 25 });
    expect(post).toHaveBeenCalledWith('/v1/discovery/playlist-criteria', {
      query: 'workout energy',
      limit: 25,
    });
  });
});
