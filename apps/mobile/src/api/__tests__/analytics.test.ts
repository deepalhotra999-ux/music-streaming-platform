// Phase 15 — analytics endpoint wrappers: verify each wrapper calls the
// right path with the right query string. The ApiClient is mocked; these
// tests pin the contract, not the transport.

import type { ApiClient } from '../client';
import {
  getArtistAlbumStats,
  getArtistOverview,
  getArtistRecentActivity,
  getArtistTrackStats,
  getArtistTrend,
  getPlatformOverview,
} from '../analytics';

function mockClient(): jest.Mocked<ApiClient> {
  return { get: jest.fn(async () => ({})) } as unknown as jest.Mocked<ApiClient>;
}

function lastPath(client: jest.Mocked<ApiClient>): string {
  return (client.get as jest.Mock).mock.calls[0][0] as string;
}

describe('analytics endpoints', () => {
  it('getArtistOverview targets the overview path with the range', async () => {
    const client = mockClient();
    await getArtistOverview(client, 'artist-1', { range: '28d' });
    expect(lastPath(client)).toBe('/v1/artists/artist-1/analytics/overview?range=28d');
  });

  it('getArtistOverview omits the query string when no options are given', async () => {
    const client = mockClient();
    await getArtistOverview(client, 'artist-1');
    expect(lastPath(client)).toBe('/v1/artists/artist-1/analytics/overview');
  });

  it('getArtistOverview passes track and album filters', async () => {
    const client = mockClient();
    await getArtistOverview(client, 'artist-1', {
      range: 'all',
      trackId: 'track-9',
      albumId: 'album-3',
    });
    const path = lastPath(client);
    expect(path.startsWith('/v1/artists/artist-1/analytics/overview?')).toBe(true);
    expect(path).toContain('range=all');
    expect(path).toContain('trackId=track-9');
    expect(path).toContain('albumId=album-3');
  });

  it('getArtistTrackStats targets the tracks path with pagination', async () => {
    const client = mockClient();
    await getArtistTrackStats(client, 'artist-1', { range: '7d', page: 2, limit: 5 });
    const path = lastPath(client);
    expect(path.startsWith('/v1/artists/artist-1/analytics/tracks?')).toBe(true);
    expect(path).toContain('range=7d');
    expect(path).toContain('page=2');
    expect(path).toContain('limit=5');
  });

  it('getArtistAlbumStats targets the albums path', async () => {
    const client = mockClient();
    await getArtistAlbumStats(client, 'artist-1', { range: '90d' });
    expect(lastPath(client)).toBe('/v1/artists/artist-1/analytics/albums?range=90d');
  });

  it('getArtistTrend targets the trend path with granularity', async () => {
    const client = mockClient();
    await getArtistTrend(client, 'artist-1', { range: '90d', granularity: 'week' });
    const path = lastPath(client);
    expect(path.startsWith('/v1/artists/artist-1/analytics/trend?')).toBe(true);
    expect(path).toContain('range=90d');
    expect(path).toContain('granularity=week');
  });

  it('getArtistRecentActivity targets the recent path with a limit', async () => {
    const client = mockClient();
    await getArtistRecentActivity(client, 'artist-1', { range: '7d', limit: 10 });
    const path = lastPath(client);
    expect(path.startsWith('/v1/artists/artist-1/analytics/recent?')).toBe(true);
    expect(path).toContain('range=7d');
    expect(path).toContain('limit=10');
  });

  it('getPlatformOverview targets the platform path (admin only)', async () => {
    const client = mockClient();
    await getPlatformOverview(client, { range: 'all' });
    expect(lastPath(client)).toBe('/v1/analytics/platform/overview?range=all');
  });
});
