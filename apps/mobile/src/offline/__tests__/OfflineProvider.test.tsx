// Phase 25 — OfflineProvider: lifecycle and ordering.
//
// The provider owns one DownloadManager per mount, runs crash recovery
// before the first refresh, starts the connectivity sync on mount, and
// stops both on unmount (sign-out). Downloads persist on disk; the
// manager does not auto-resume interrupted downloads.

import { render, screen, waitFor, act } from '@testing-library/react-native';
import { Text } from 'react-native';
import { OfflineProvider, useOffline } from '../OfflineProvider';
import { DownloadManager } from '../downloadManager';
import { recoverInterruptedDownloads } from '../metadataStore';
import { startOfflineSync } from '../sync';
import { revalidateAll } from '../revalidator';
import { offlineStorageUsage } from '../storage';

jest.mock('../downloadManager', () => ({
  DownloadManager: jest.fn(),
}));
jest.mock('../metadataStore', () => ({
  recoverInterruptedDownloads: jest.fn(),
  getDownloadRecord: jest.fn(),
}));
jest.mock('../sync', () => ({
  startOfflineSync: jest.fn(),
}));
jest.mock('../revalidator', () => ({
  revalidateAll: jest.fn(),
}));
jest.mock('../storage', () => ({
  offlineStorageUsage: jest.fn(),
  offlineRoot: () => 'file:///docs/offline/',
  trackDir: (id: string) => `file:///docs/offline/${id}/`,
  audioFile: (id: string) => `file:///docs/offline/${id}/audio.ts`,
}));

const MockDownloadManager = DownloadManager as jest.Mock;
const mockRecover = recoverInterruptedDownloads as jest.Mock;
const mockStartSync = startOfflineSync as jest.Mock;
const mockRevalidateAll = revalidateAll as jest.Mock;
const mockStorageUsage = offlineStorageUsage as jest.Mock;

const api = { get: jest.fn(), post: jest.fn() } as never;

interface ManagerDouble {
  enqueue: jest.Mock;
  pause: jest.Mock;
  resume: jest.Mock;
  cancel: jest.Mock;
  retry: jest.Mock;
  remove: jest.Mock;
  list: jest.Mock;
  stop: jest.Mock;
}

function makeManager(): ManagerDouble {
  return {
    enqueue: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined),
    resume: jest.fn(async () => undefined),
    cancel: jest.fn(async () => undefined),
    retry: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    list: jest.fn(async () => []),
    stop: jest.fn(async () => undefined),
  };
}

function Probe() {
  const offline = useOffline();
  return <Text testID="probe">{`downloads:${offline.downloads.length}`}</Text>;
}

describe('OfflineProvider', () => {
  let manager: ManagerDouble;
  let stopSync: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = makeManager();
    MockDownloadManager.mockImplementation(() => manager);
    mockRecover.mockResolvedValue([]);
    mockStorageUsage.mockResolvedValue(0);
    stopSync = jest.fn();
    mockStartSync.mockReturnValue(stopSync);
    mockRevalidateAll.mockResolvedValue({ renewed: 0, invalidated: 0 });
  });

  it('throws when useOffline is used outside the provider', () => {
    expect(() => render(<Probe />)).toThrow('useOffline must be used within OfflineProvider');
  });

  it('creates one manager, runs crash recovery, then starts sync on mount', async () => {
    render(
      <OfflineProvider api={api}>
        <Probe />
      </OfflineProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toBeTruthy());
    expect(MockDownloadManager).toHaveBeenCalledTimes(1);
    expect(mockRecover).toHaveBeenCalledTimes(1);
    expect(mockStartSync).toHaveBeenCalledTimes(1);
    // Crash recovery runs before the sync starts serving refreshes: the
    // effect awaits recovery, then starts sync, then refreshes.
    const recoverOrder = mockRecover.mock.invocationCallOrder[0];
    const syncOrder = mockStartSync.mock.invocationCallOrder[0];
    expect(recoverOrder).toBeLessThan(syncOrder);
  });

  it('stops the sync and the manager on unmount (sign-out)', async () => {
    const { unmount } = render(
      <OfflineProvider api={api}>
        <Probe />
      </OfflineProvider>,
    );
    await waitFor(() => expect(mockStartSync).toHaveBeenCalled());
    unmount();
    expect(stopSync).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it('downloadTracks enqueues sequentially and is duplicate-safe per enqueue', async () => {
    let ctx: ReturnType<typeof useOffline> | null = null;
    function Capture() {
      ctx = useOffline();
      return null;
    }
    render(
      <OfflineProvider api={api}>
        <Capture />
      </OfflineProvider>,
    );
    await waitFor(() => expect(ctx).not.toBeNull());
    const tracks = [
      { id: 't1', title: 'One', artistName: 'A', albumTitle: null, durationMs: 1000 },
      { id: 't2', title: 'Two', artistName: 'A', albumTitle: null, durationMs: 2000 },
    ];
    await act(async () => {
      await ctx!.downloadTracks(tracks as never);
    });
    expect(manager.enqueue).toHaveBeenCalledTimes(2);
    expect(manager.enqueue).toHaveBeenNthCalledWith(1, 't1', {
      title: 'One',
      artistName: 'A',
      albumTitle: null,
      durationMs: 1000,
    });
    expect(manager.enqueue).toHaveBeenNthCalledWith(2, 't2', {
      title: 'Two',
      artistName: 'A',
      albumTitle: null,
      durationMs: 2000,
    });
  });

  it('revalidateNow delegates to revalidateAll and refreshes', async () => {
    let ctx: ReturnType<typeof useOffline> | null = null;
    function Capture() {
      ctx = useOffline();
      return null;
    }
    render(
      <OfflineProvider api={api}>
        <Capture />
      </OfflineProvider>,
    );
    await waitFor(() => expect(ctx).not.toBeNull());
    mockRevalidateAll.mockResolvedValue({ renewed: 2, invalidated: 1 });
    let summary: unknown;
    await act(async () => {
      summary = await ctx!.revalidateNow();
    });
    expect(mockRevalidateAll).toHaveBeenCalledWith(api);
    expect(summary).toEqual({ renewed: 2, invalidated: 1 });
  });
});
