// Phase 12 — SearchScreen integration: empty/loading/error/no-result
// states, debounced multi-category search against a fake API, result taps
// (navigation + playback-engine integration), and the on-device recent
// search experience.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { useAuth } from '../../auth';
import { useQueueActions } from '../../player';
import { SearchScreen } from '../SearchScreen';

jest.mock('../../auth', () => ({
  useAuth: jest.fn(),
}));

jest.mock('../../player', () => ({
  useQueueActions: jest.fn(),
}));

const mockUseAuth = useAuth as jest.Mock;
const mockUseQueueActions = useQueueActions as jest.Mock;
const mockPush = router.push as jest.Mock;

const artist = { id: 'a1', name: 'Neon Coastline', verified: false, followerCount: 5, createdAt: '' };
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

function pageOf<T>(items: T[], total: number) {
  return {
    data: items,
    pagination: { page: 1, limit: 5, total, totalPages: 1 },
  };
}

function fakeApi(handler: (path: string) => unknown) {
  const get = jest.fn(async (path: string) => handler(path));
  mockUseAuth.mockReturnValue({ api: { get } });
  return get;
}

const artist2 = { id: 'a2', name: 'Glasswing', verified: false, followerCount: 3, createdAt: '' };

function searchApi() {
  return fakeApi((path: string) => {
    const url = new URL(path, 'http://x');
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    if (path.startsWith('/v1/artists')) {
      if (q.includes('copper')) return pageOf([artist], 1);
      if (q.includes('glass')) return pageOf([artist2], 1);
      return pageOf([], 0);
    }
    if (path.startsWith('/v1/tracks'))
      return pageOf(q.includes('copper') ? [track] : [], q.includes('copper') ? 1 : 0);
    if (path.startsWith('/v1/genres'))
      return pageOf(q.includes('copper') ? [genre] : [], q.includes('copper') ? 1 : 0);
    return pageOf([], 0);
  });
}

function mockQueue() {
  const playTracks = jest.fn(async () => {}) as jest.Mock;
  const addToQueue = jest.fn(async () => {}) as jest.Mock;
  mockUseQueueActions.mockReturnValue({ playTracks, addToQueue });
  return { playTracks, addToQueue };
}

function typeQuery(text: string) {
  fireEvent.changeText(screen.getByTestId('search-bar-input'), text);
}

async function waitForResults() {
  await waitFor(() => expect(screen.getByTestId('search-results')).toBeTruthy(), {
    timeout: 5000,
  });
}

describe('SearchScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AsyncStorage as unknown as { __reset: () => void }).__reset();
    mockQueue();
  });

  it('shows the empty state when there is no query and no recents', async () => {
    searchApi();
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.queryByTestId('recent-searches')).toBeNull();
  });

  it('debounces typing and renders categorized results', async () => {
    const get = searchApi();
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    typeQuery('copper');
    // Debounce: rapid typing issues a single fan-out.
    await waitForResults();
    expect(get).toHaveBeenCalledTimes(5);
    expect(screen.getByTestId('search-results-artists')).toBeTruthy();
    expect(screen.getByTestId('search-results-tracks')).toBeTruthy();
    expect(screen.getByTestId('search-results-genres')).toBeTruthy();
    expect(screen.getByTestId('artist-row-a1')).toBeTruthy();
    expect(screen.getByTestId('track-row-t1')).toBeTruthy();
  });

  it('shows a no-results state when every category is empty', async () => {
    searchApi();
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    typeQuery('zzz-no-such-thing');
    await waitFor(() => expect(screen.getByTestId('search-no-results')).toBeTruthy());
  });

  it('shows an error state with a working retry', async () => {
    const get = fakeApi(() => {
      throw new Error('network down');
    });
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    typeQuery('copper');
    await waitFor(() => expect(screen.getByTestId('search-error')).toBeTruthy());

    // Retry re-issues the same debounced query (still failing).
    fireEvent.press(screen.getByText('Try again'));
    await waitFor(() => expect(screen.getByTestId('search-error')).toBeTruthy());
    expect(get.mock.calls.length).toBeGreaterThan(5);
  });

  it('tapping an artist navigates to its detail screen and records the search', async () => {
    searchApi();
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    typeQuery('copper');
    await waitForResults();

    fireEvent.press(screen.getByTestId('artist-row-a1'));
    expect(mockPush).toHaveBeenCalledWith('/artist/a1');

    // The query is now a recent search: clearing the input reveals it.
    typeQuery('');
    await waitFor(() => expect(screen.getByTestId('recent-searches')).toBeTruthy());
    expect(screen.getByTestId('recent-searches-item-copper')).toBeTruthy();
  });

  it('tapping a track plays it through the playback engine (tap index into results)', async () => {
    const { playTracks } = mockQueue();
    searchApi();
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    typeQuery('copper');
    await waitForResults();

    fireEvent.press(screen.getByTestId('track-row-t1'));
    expect(playTracks).toHaveBeenCalledTimes(1);
    const [tracks, index] = playTracks.mock.calls[0] as [{ id: string }[], number];    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.id).toBe('t1');
    expect(index).toBe(0);
    // Track taps play — they do not navigate.
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('long-pressing a track adds it to the existing queue', async () => {
    const { addToQueue } = mockQueue();
    searchApi();
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    typeQuery('copper');
    await waitForResults();

    fireEvent(screen.getByTestId('track-row-t1'), 'longPress');
    expect(addToQueue).toHaveBeenCalledTimes(1);
    const [queued] = addToQueue.mock.calls[0] as [{ id: string }];
    expect(queued.id).toBe('t1');
  });

  it('supports removing one recent and clearing all recents', async () => {
    searchApi();
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    // Two searches → two recents, most-recent-first.
    typeQuery('copper');
    await waitForResults();
    fireEvent.press(screen.getByTestId('artist-row-a1'));

    typeQuery('glass');
    // Wait for the glass search itself (results differ per query), otherwise
    // the tap below would record the still-debounced previous query.
    await waitFor(() => expect(screen.getByTestId('artist-row-a2')).toBeTruthy());
    fireEvent.press(screen.getByTestId('artist-row-a2'));

    typeQuery('');
    await waitFor(() => expect(screen.getByTestId('recent-searches')).toBeTruthy());
    expect(screen.getByTestId('recent-searches-item-glass')).toBeTruthy();
    expect(screen.getByTestId('recent-searches-item-copper')).toBeTruthy();

    // Remove one recent; the other stays.
    fireEvent.press(screen.getByTestId('recent-searches-remove-copper'));
    await waitFor(() =>
      expect(screen.queryByTestId('recent-searches-item-copper')).toBeNull(),
    );
    expect(screen.getByTestId('recent-searches-item-glass')).toBeTruthy();

    // Clear all → back to the empty state.
    fireEvent.press(screen.getByTestId('recent-searches-clear-all'));
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.queryByTestId('recent-searches')).toBeNull();
  });

  it('tapping a recent search re-runs it', async () => {
    searchApi();
    render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    typeQuery('copper');
    await waitForResults();
    fireEvent.press(screen.getByTestId('artist-row-a1'));

    typeQuery('');
    await waitFor(() => expect(screen.getByTestId('recent-searches')).toBeTruthy());
    fireEvent.press(screen.getByTestId('recent-searches-item-copper'));
    await waitForResults();
    expect(screen.getByTestId('track-row-t1')).toBeTruthy();
  });
});
