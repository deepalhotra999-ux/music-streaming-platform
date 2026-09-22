// Phase 21 — ArtistRoyaltiesScreen: overview, periods, track breakdown,
// and loading/empty/error/retry/unauthorized states.
// The ApiClient is mocked at the `get` level with path-based routing.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useAuth } from '../../auth';
import { useRouter } from 'expo-router';
import { formatMoney } from '../../api/royalties';
import { ArtistRoyaltiesScreen } from '../ArtistRoyaltiesScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('expo-router', () => ({
  useRouter: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseRouter = useRouter as jest.Mock;

function pageOf<T>(items: T[]) {
  return {
    data: items,
    pagination: { page: 1, limit: 10, total: items.length, totalPages: 1 },
  };
}

const artistListItem = { id: 'a1', name: 'Neon Bloom', verified: true };

const overview = {
  artistId: 'a1',
  currency: 'USD',
  totalEarnings: '630.00',
  totalStreams: 9,
  completedPeriods: 1,
  latestPeriod: {
    periodId: 'p1',
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    earnings: '630.00',
    streams: 9,
    runId: 'r1',
    policyVersion: 1,
  },
};

const periods = [
  {
    periodId: 'p1',
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
    status: 'COMPLETED',
    currency: 'USD',
    earnings: '630.00',
    streams: 9,
    runId: 'r1',
    policyVersion: 1,
  },
];

const tracks = [
  {
    trackId: 't1',
    title: 'Track A',
    eligibleStreams: 6,
    allocationPercentage: '66.67',
    grossAmount: '420.00',
    adjustmentsTotal: '0.00',
    finalAmount: '420.00',
    currency: 'USD',
  },
  {
    trackId: 't2',
    title: 'Track B',
    eligibleStreams: 3,
    allocationPercentage: '33.33',
    grossAmount: '210.00',
    adjustmentsTotal: '0.00',
    finalAmount: '210.00',
    currency: 'USD',
  },
];

function mockApi(getImpl: (path: string) => Promise<unknown>) {
  const get = jest.fn((path: string) => getImpl(path));
  mockUseAuth.mockReturnValue({ api: { get } });
  return get;
}

function route(path: string) {
  if (path === '/v1/me/artists') return pageOf([artistListItem]);
  if (path.includes('/royalties/overview')) return overview;
  if (path.includes('/royalties/periods/') && path.includes('/tracks')) return pageOf(tracks);
  if (path.includes('/royalties/periods')) return pageOf(periods);
  throw new Error(`unexpected path: ${path}`);
}

describe('ArtistRoyaltiesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRouter.mockReturnValue({ push: jest.fn() });
  });

  it('renders overview with total earnings and latest period', async () => {
    mockApi(async (p) => route(p));
    render(<ArtistRoyaltiesScreen initialArtistId="a1" />);

    await waitFor(() => {
      expect(screen.getByTestId('total-earnings')).toBeTruthy();
    });
    // Total earnings appears in the testID element
    const totalEl = screen.getByTestId('total-earnings');
    expect(totalEl.props.children).toBe('USD 630.00');
    expect(screen.getByText(/9 eligible streams/)).toBeTruthy();
  });

  it('navigates to period detail on tap', async () => {
    const mockPush = jest.fn();
    mockUseRouter.mockReturnValue({ push: mockPush });
    mockApi(async (p) => route(p));
    render(<ArtistRoyaltiesScreen initialArtistId="a1" />);

    // Wait for periods to load
    await waitFor(() => {
      expect(screen.getByText(/Completed/)).toBeTruthy();
    });
    // Tap the period header (use the one in the periods list,
    // not the latest-period summary — getAllByText returns both)
    const headers = screen.getAllByText(/Aug 2026/);
    // The period list header is the last one (latest-period box comes first)
    const periodHeader = headers[headers.length - 1];
    fireEvent.press(periodHeader);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/(artist)/royalties/[periodId]',
        params: { artistId: 'a1', periodId: 'p1' },
      });
    });
  });

  it('shows empty state when no earnings yet', async () => {
    const emptyOverview = {
      ...overview,
      completedPeriods: 0,
      totalEarnings: '0.00',
      totalStreams: 0,
      latestPeriod: null,
    };
    mockApi(async (p) => {
      if (p.includes('/royalties/overview')) return emptyOverview;
      if (p.includes('/royalties/periods')) return pageOf([]);
      return route(p);
    });
    render(<ArtistRoyaltiesScreen initialArtistId="a1" />);

    await waitFor(() => {
      expect(screen.getByText('No royalties yet')).toBeTruthy();
    });
  });

  it('shows error state with retry', async () => {
    const get = mockApi(async () => {
      throw new Error('Network error');
    });
    render(<ArtistRoyaltiesScreen initialArtistId="a1" />);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeTruthy();
    });
    // Retry calls the API again
    const retryButton = screen.getByText('Try again');
    fireEvent.press(retryButton);
    await waitFor(() => {
      expect(get).toHaveBeenCalledTimes(4); // 2 initial + 2 retry
    });
  });

  it('shows unauthorized state for 403', async () => {
    mockApi(async () => {
      const err = new Error('Request failed with status 403 Forbidden') as Error & {
        status?: number;
      };
      err.status = 403;
      throw err;
    });
    render(<ArtistRoyaltiesScreen initialArtistId="a1" />);

    await waitFor(() => {
      expect(screen.getByText('Not authorized')).toBeTruthy();
    });
  });

  it('bootstraps artist list when no initial artist ID', async () => {
    const get = mockApi(async (p) => route(p));
    render(<ArtistRoyaltiesScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('total-earnings')).toBeTruthy();
    });
    // Should fetch artists once, then overview + periods
    const artistCalls = get.mock.calls.filter((c) => c[0] === '/v1/me/artists');
    expect(artistCalls.length).toBe(1);
  });
});

describe('formatMoney', () => {
  it('formats exact decimal strings without Number conversion', () => {
    expect(formatMoney('630.00', 'USD')).toBe('USD 630.00');
    expect(formatMoney('630', 'USD')).toBe('USD 630.00');
    expect(formatMoney('12345678901234567890.99', 'USD')).toBe('USD 12345678901234567890.99');
    expect(formatMoney('0.1', 'USD')).toBe('USD 0.10');
    expect(formatMoney('invalid', 'USD')).toBe('invalid USD');
  });
});
