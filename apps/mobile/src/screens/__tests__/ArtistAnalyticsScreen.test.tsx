// Phase 15 — ArtistAnalyticsScreen: stat cards, trend chart, top
// tracks/albums, recent activity, and loading/empty/error/retry states.
// The ApiClient is mocked at the `get` level with path-based routing.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useAuth } from '../../auth';
import { ArtistAnalyticsScreen } from '../ArtistAnalyticsScreen';

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

const overview = {
  artistId: 'a1',
  range: '28d',
  from: '2026-08-24T00:00:00.000Z',
  to: '2026-09-21T00:00:00.000Z',
  streams: 1250,
  starts: 1400,
  failedPlays: 12,
  incompletePlays: 138,
  uniqueListeners: 320,
  listeningTimeMs: 3_900_000,
};

const trend = {
  granularity: 'day',
  points: [
    {
      date: '2026-09-18',
      streams: 40,
      starts: 45,
      failedPlays: 0,
      incompletePlays: 5,
      uniqueListeners: 30,
      listeningTimeMs: 120_000,
    },
    {
      date: '2026-09-19',
      streams: 60,
      starts: 66,
      failedPlays: 1,
      incompletePlays: 5,
      uniqueListeners: 44,
      listeningTimeMs: 180_000,
    },
  ],
};

const trackStats = [
  {
    trackId: 't1',
    title: 'First Light',
    streams: 800,
    starts: 880,
    failedPlays: 8,
    incompletePlays: 72,
    uniqueListeners: 200,
    listeningTimeMs: 2_400_000,
  },
  {
    trackId: 't2',
    title: 'Afterglow',
    streams: 450,
    starts: 520,
    failedPlays: 4,
    incompletePlays: 66,
    uniqueListeners: 120,
    listeningTimeMs: 1_500_000,
  },
];

const albumStats = [
  {
    albumId: 'al1',
    title: 'Neon Skies',
    streams: 1250,
    starts: 1400,
    failedPlays: 12,
    incompletePlays: 138,
    uniqueListeners: 320,
    listeningTimeMs: 3_900_000,
  },
];

const recent = [
  {
    sessionId: 's1',
    trackId: 't1',
    trackTitle: 'First Light',
    playedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    listeningTimeMs: 180_000,
  },
];

function mockApi(overrides: Record<string, unknown> = {}) {
  const get = jest.fn(async (path: string) => {
    if (path in overrides) {
      const value = overrides[path];
      if (value instanceof Error) throw value;
      return value;
    }
    if (path === '/v1/me/artists') return pageOf([artistListItem]);
    if (path.startsWith('/v1/artists/a1/analytics/overview')) return overview;
    if (path.startsWith('/v1/artists/a1/analytics/trend')) return trend;
    if (path.startsWith('/v1/artists/a1/analytics/tracks')) return pageOf(trackStats);
    if (path.startsWith('/v1/artists/a1/analytics/albums')) return pageOf(albumStats);
    if (path.startsWith('/v1/artists/a1/analytics/recent')) return { data: recent };
    throw new Error(`unexpected path ${path}`);
  });
  mockUseAuth.mockReturnValue({ api: { get }, user: { id: 'u1', role: 'ARTIST' } });
  return { get };
}

describe('ArtistAnalyticsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders stat cards, trend, top tracks/albums, and recent activity', async () => {
    mockApi();
    render(<ArtistAnalyticsScreen />);
    await waitFor(() => expect(screen.getByTestId('stat-grid')).toBeTruthy());

    expect(screen.getByTestId('stat-streams')).toHaveTextContent('1.3KStreams');
    expect(screen.getByTestId('stat-listeners')).toHaveTextContent('320Listeners');
    expect(screen.getByTestId('stat-listening-time')).toHaveTextContent('1 h 5 minListening time');
    expect(screen.getByTestId('stat-starts')).toHaveTextContent('1.4KPlay attempts');
    expect(screen.getByTestId('outcome-note')).toHaveTextContent(
      '12 failed · 138 incomplete plays in this range',
    );

    expect(screen.getByTestId('trend-chart')).toBeTruthy();
    expect(screen.getByTestId('top-tracks')).toBeTruthy();
    expect(screen.getAllByText('First Light').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('top-albums')).toBeTruthy();
    expect(screen.getByText('Neon Skies')).toBeTruthy();
    expect(screen.getByTestId('recent-activity')).toBeTruthy();
  });

  it('refetches with the new range when the range selector changes', async () => {
    const { get } = mockApi();
    render(<ArtistAnalyticsScreen />);
    await waitFor(() => expect(screen.getByTestId('stat-grid')).toBeTruthy());

    fireEvent.press(screen.getByTestId('range-7d'));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        expect.stringContaining('/v1/artists/a1/analytics/overview?range=7d'),
      ),
    );
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('/v1/artists/a1/analytics/trend?range=7d&granularity=day'),
    );
  });

  it('shows the empty state when the artist has no plays', async () => {
    mockApi({
      '/v1/artists/a1/analytics/overview?range=28d': { ...overview, streams: 0, starts: 0 },
      '/v1/artists/a1/analytics/tracks?range=28d&limit=5': pageOf([]),
      '/v1/artists/a1/analytics/albums?range=28d&limit=5': pageOf([]),
      '/v1/artists/a1/analytics/recent?range=28d&limit=10': { data: [] },
    });
    render(<ArtistAnalyticsScreen />);
    await waitFor(() => expect(screen.getByTestId('analytics-empty')).toBeTruthy());
    expect(screen.queryByTestId('stat-grid')).toBeNull();
  });

  it('shows the error state with a working retry', async () => {
    const failure = new Error('network down');
    let failOverview = true;
    const get = jest.fn(async (path: string) => {
      if (path === '/v1/me/artists') return pageOf([artistListItem]);
      if (path.startsWith('/v1/artists/a1/analytics/overview')) {
        if (failOverview) throw failure;
        return overview;
      }
      if (path.startsWith('/v1/artists/a1/analytics/trend')) return trend;
      if (path.startsWith('/v1/artists/a1/analytics/tracks')) return pageOf(trackStats);
      if (path.startsWith('/v1/artists/a1/analytics/albums')) return pageOf(albumStats);
      if (path.startsWith('/v1/artists/a1/analytics/recent')) return { data: recent };
      throw new Error(`unexpected path ${path}`);
    });
    mockUseAuth.mockReturnValue({ api: { get }, user: { id: 'u1', role: 'ARTIST' } });

    render(<ArtistAnalyticsScreen />);
    await waitFor(() => expect(screen.getByTestId('error-state')).toBeTruthy());

    failOverview = false;
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByTestId('stat-grid')).toBeTruthy());
  });

  it('shows the no-artist empty state', async () => {
    mockApi({ '/v1/me/artists': pageOf([]) });
    render(<ArtistAnalyticsScreen />);
    await waitFor(() => expect(screen.getByText('No artist profile yet')).toBeTruthy());
  });

  it('prefers the initial artist id when provided', async () => {
    const { get } = mockApi({
      '/v1/me/artists': pageOf([artistListItem, { id: 'a2', name: 'Second Act', verified: false }]),
    });
    const getA2 = jest.fn(async (path: string) => {
      if (path === '/v1/me/artists') {
        return pageOf([artistListItem, { id: 'a2', name: 'Second Act', verified: false }]);
      }
      if (path.startsWith('/v1/artists/a2/analytics/')) {
        if (path.includes('/overview')) return { ...overview, artistId: 'a2' };
        if (path.includes('/trend')) return trend;
        if (path.includes('/tracks')) return pageOf(trackStats);
        if (path.includes('/albums')) return pageOf(albumStats);
        if (path.includes('/recent')) return { data: recent };
      }
      throw new Error(`unexpected path ${path}`);
    });
    mockUseAuth.mockReturnValue({ api: { get: getA2 }, user: { id: 'u1', role: 'ARTIST' } });
    void get;

    render(<ArtistAnalyticsScreen initialArtistId="a2" />);
    await waitFor(() => expect(screen.getByTestId('stat-grid')).toBeTruthy());
    expect(getA2).toHaveBeenCalledWith(
      expect.stringContaining('/v1/artists/a2/analytics/overview'),
    );
  });
});
