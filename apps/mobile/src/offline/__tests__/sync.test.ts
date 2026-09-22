// Phase 25 — startOfflineSync: connectivity-driven flush + revalidation.
//
// NetInfo fires the current state immediately on subscribe, so the first
// event doubles as the startup check: already online → sync now.
// Later false→true transitions cover regained connectivity; staying
// online or going offline never syncs.

import { startOfflineSync } from '../sync';
import { flushOfflineEvents } from '../eventQueue';
import { revalidateAll } from '../revalidator';

jest.mock('../eventQueue', () => ({
  flushOfflineEvents: jest.fn(),
}));
jest.mock('../revalidator', () => ({
  revalidateAll: jest.fn(),
}));

type NetInfoListener = (state: {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}) => void;

const listeners = new Set<NetInfoListener>();
const mockAddEventListener = jest.fn((listener: NetInfoListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
});
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: (l: NetInfoListener) => mockAddEventListener(l) },
}));

const mockFlush = flushOfflineEvents as jest.Mock;
const mockRevalidate = revalidateAll as jest.Mock;

const api = { get: jest.fn(), post: jest.fn() } as never;

const online = { isConnected: true, isInternetReachable: true };
const offline = { isConnected: false, isInternetReachable: false };

function emit(state: { isConnected: boolean | null; isInternetReachable: boolean | null }) {
  for (const listener of [...listeners]) listener(state);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('startOfflineSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listeners.clear();
    mockFlush.mockResolvedValue({ uploaded: 0, rejected: [], retryable: false });
    mockRevalidate.mockResolvedValue({ renewed: 0, invalidated: 0 });
  });

  it('syncs immediately when the app starts already online', async () => {
    const onEventsFlushed = jest.fn();
    const stop = startOfflineSync(api, { onEventsFlushed });
    // NetInfo's first event reports the current state: online.
    emit(online);
    await flush();
    await flush();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
    expect(onEventsFlushed).toHaveBeenCalledWith(0, 0);
    stop();
  });

  it('does not sync when the app starts offline', async () => {
    const stop = startOfflineSync(api);
    emit(offline);
    await flush();
    await flush();
    expect(mockFlush).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
    stop();
  });

  it('syncs on regained connectivity (false→true transition)', async () => {
    const stop = startOfflineSync(api);
    emit(offline);
    await flush();
    expect(mockFlush).not.toHaveBeenCalled();
    emit(online);
    await flush();
    await flush();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not re-sync while staying online', async () => {
    const stop = startOfflineSync(api);
    emit(online);
    await flush();
    await flush();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    emit(online);
    await flush();
    await flush();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    stop();
  });

  it('skips revalidation when the event flush hit a retryable network failure', async () => {
    const stop = startOfflineSync(api);
    mockFlush.mockResolvedValue({ uploaded: 0, rejected: [], retryable: true });
    emit(online);
    await flush();
    await flush();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    // A hard network failure means revalidation would fail too.
    expect(mockRevalidate).not.toHaveBeenCalled();
    stop();
  });

  it('reports sync errors through onSyncError without throwing', async () => {
    const onSyncError = jest.fn();
    const stop = startOfflineSync(api, { onSyncError });
    mockFlush.mockRejectedValue(new Error('disk gone'));
    emit(online);
    await flush();
    await flush();
    expect(onSyncError).toHaveBeenCalledTimes(1);
    stop();
  });

  it('unsubscribes from NetInfo on stop', async () => {
    const stop = startOfflineSync(api);
    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
    emit(online);
    await flush();
    await flush();
    expect(mockFlush).not.toHaveBeenCalled();
  });
});
