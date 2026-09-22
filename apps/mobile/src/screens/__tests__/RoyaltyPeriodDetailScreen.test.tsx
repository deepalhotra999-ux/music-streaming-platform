// Phase 22 — RoyaltyPeriodDetailScreen: statement, explainable calculation,
// track breakdown, policy info, status states, and CSV export.
// The ApiClient is mocked at the `get` level with path-based routing.

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useAuth } from '../../auth';
import { RoyaltyPeriodDetailScreen } from '../RoyaltyPeriodDetailScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('expo-file-system', () => ({
  Paths: { document: { uri: 'file:///doc/' } },
  File: jest.fn().mockImplementation(() => ({
    write: jest.fn(),
    uri: 'file:///doc/STMT-202608-A1B2C3.csv',
  })),
}));

jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockUseAuth = useAuth as jest.Mock;

function pageOf<T>(items: T[]) {
  return {
    data: items,
    pagination: { page: 1, limit: 50, total: items.length, totalPages: 1 },
  };
}

const statement = {
  statementReference: 'STMT-202608-A1B2C3',
  artistId: 'a1',
  artistName: 'Neon Bloom',
  periodId: 'p1',
  periodStart: '2026-08-01T00:00:00.000Z',
  periodEnd: '2026-09-01T00:00:00.000Z',
  currency: 'USD',
  status: 'COMPLETED',
  finalizedAt: '2026-09-02T00:00:00.000Z',
  policy: {
    version: 1,
    name: 'Test Policy',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    streamEligibilityRule: 'A playback session counts as one eligible stream when it contains at least one completed play.',
    allocationMethodology: 'Earnings are allocated proportionally.',
    roundingMethodology: 'Amounts are calculated in cents using integer arithmetic.',
    isTestPolicy: true,
    minimumStreams: null,
  },
  eligibleStreams: 9,
  totalEligibleStreams: 9,
  artistSharePercentage: '100',
  royaltyPool: '630.00',
  artistAllocation: '630.00',
  adjustmentsTotal: '0.00',
  residualAmount: '0.00',
  finalEarnings: '630.00',
  calculation: [
    { label: 'Your eligible streams', value: '9', explanation: 'Playback sessions with at least one completed play.' },
    { label: 'Your final earnings', value: '630.00', explanation: 'Your allocation plus adjustments.' },
  ],
};

const tracks = [
  {
    trackId: 't1',
    title: 'Track A',
    eligibleStreams: 6,
    shareOfArtistStreams: '66.666666',
    grossAmount: '420.00',
    adjustmentsTotal: '0.00',
    finalAmount: '420.00',
    currency: 'USD',
  },
  {
    trackId: 't2',
    title: 'Track B',
    eligibleStreams: 3,
    shareOfArtistStreams: '33.333333',
    grossAmount: '210.00',
    adjustmentsTotal: '0.00',
    finalAmount: '210.00',
    currency: 'USD',
  },
];

function mockApi(getImpl: (path: string) => Promise<unknown>, getTextImpl?: (path: string) => Promise<string>) {
  const get = jest.fn((path: string) => getImpl(path));
  const getText = jest.fn((path: string) => (getTextImpl ? getTextImpl(path) : Promise.resolve('')));
  mockUseAuth.mockReturnValue({ api: { get, getText } });
  return { get, getText };
}

function renderScreen() {
  return render(<RoyaltyPeriodDetailScreen artistId="a1" periodId="p1" />);
}

describe('RoyaltyPeriodDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders statement summary with finalized earnings', async () => {
    mockApi((path) => {
      if (path.includes('/statement/tracks')) return Promise.resolve(pageOf(tracks));
      if (path.includes('/statement')) return Promise.resolve(statement);
      throw new Error(`unexpected ${path}`);
    });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('statement-earnings')).toHaveTextContent('USD 630.00');
    });
    expect(screen.getByText(/STMT-202608-A1B2C3/)).toBeTruthy();
    expect(screen.getByText('Finalized')).toBeTruthy();
  });

  it('renders explainable calculation steps', async () => {
    mockApi((path) => {
      if (path.includes('/statement/tracks')) return Promise.resolve(pageOf(tracks));
      if (path.includes('/statement')) return Promise.resolve(statement);
      throw new Error(`unexpected ${path}`);
    });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText('How this was calculated')).toBeTruthy();
    });
    expect(screen.getByText('Your eligible streams')).toBeTruthy();
    expect(screen.getByText('Your final earnings')).toBeTruthy();
  });

  it('renders track breakdown with share of artist streams', async () => {
    mockApi((path) => {
      if (path.includes('/statement/tracks')) return Promise.resolve(pageOf(tracks));
      if (path.includes('/statement')) return Promise.resolve(statement);
      throw new Error(`unexpected ${path}`);
    });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText('Track A')).toBeTruthy();
    });
    expect(screen.getByText('Track B')).toBeTruthy();
    expect(screen.getByText(/66.666666% of/)).toBeTruthy();
  });

  it('renders policy information with test policy label', async () => {
    mockApi((path) => {
      if (path.includes('/statement/tracks')) return Promise.resolve(pageOf(tracks));
      if (path.includes('/statement')) return Promise.resolve(statement);
      throw new Error(`unexpected ${path}`);
    });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText('Test policy — values are placeholders')).toBeTruthy();
    });
    expect(screen.getByText('Stream eligibility')).toBeTruthy();
    expect(screen.getByText('Allocation')).toBeTruthy();
    expect(screen.getByText('Rounding')).toBeTruthy();
  });

  it('shows pending state without finalized earnings', async () => {
    const pending = { ...statement, status: 'PENDING', finalizedAt: null, finalEarnings: '0.00', calculation: [] };
    mockApi((path) => {
      if (path.includes('/statement')) return Promise.resolve(pending);
      throw new Error(`unexpected ${path}`);
    });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeTruthy();
    });
    expect(screen.getByText(/not been calculated yet/)).toBeTruthy();
    // No export button for pending
    expect(screen.queryByTestId('export-csv-button')).toBeNull();
  });

  it('shows failed state', async () => {
    const failed = { ...statement, status: 'FAILED', finalizedAt: null, finalEarnings: '0.00', calculation: [] };
    mockApi((path) => {
      if (path.includes('/statement')) return Promise.resolve(failed);
      throw new Error(`unexpected ${path}`);
    });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText('Failed')).toBeTruthy();
    });
    expect(screen.getByText(/calculation failed/)).toBeTruthy();
  });

  it('shows error state with retry', async () => {
    const get = jest.fn().mockRejectedValue(new Error('Network error'));
    mockUseAuth.mockReturnValue({ api: { get, getText: jest.fn() } });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeTruthy();
    });
    // Retry
    get.mockImplementation((path: string) => {
      if (path.includes('/statement/tracks')) return Promise.resolve(pageOf(tracks));
      if (path.includes('/statement')) return Promise.resolve(statement);
      throw new Error(`unexpected ${path}`);
    });
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => {
      expect(screen.getByTestId('statement-earnings')).toHaveTextContent('USD 630.00');
    });
  });

  it('shows unauthorized state on 403', async () => {
    const get = jest.fn().mockRejectedValue(new Error('Request failed (403)'));
    mockUseAuth.mockReturnValue({ api: { get, getText: jest.fn() } });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText('Not authorized')).toBeTruthy();
    });
  });

  it('exports CSV via share sheet', async () => {
    const { getText } = mockApi(
      (path) => {
        if (path.includes('/statement/tracks')) return Promise.resolve(pageOf(tracks));
        if (path.includes('/statement')) return Promise.resolve(statement);
        throw new Error(`unexpected ${path}`);
      },
      () => Promise.resolve('Royalty Statement\nArtist,Neon Bloom\n'),
    );
    const Sharing = require('expo-sharing');
    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('export-csv-button')).toBeTruthy();
    });
    fireEvent.press(screen.getByTestId('export-csv-button'));
    await waitFor(() => {
      expect(getText).toHaveBeenCalledWith(
        '/v1/artists/a1/royalties/periods/p1/statement.csv',
      );
    });
    await waitFor(() => {
      expect(Sharing.shareAsync).toHaveBeenCalled();
    });
  });

  it('retries track loading without losing statement', async () => {
    let trackCalls = 0;
    mockApi((path) => {
      if (path.includes('/statement/tracks')) {
        trackCalls++;
        if (trackCalls === 1) return Promise.reject(new Error('Track load failed'));
        return Promise.resolve(pageOf(tracks));
      }
      if (path.includes('/statement')) return Promise.resolve(statement);
      throw new Error(`unexpected ${path}`);
    });
    renderScreen();
    await waitFor(() => {
      expect(screen.getByText(/Track load failed/)).toBeTruthy();
    });
    // Statement still visible
    expect(screen.getByTestId('statement-earnings')).toHaveTextContent('USD 630.00');
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => {
      expect(screen.getByText('Track A')).toBeTruthy();
    });
  });
});
