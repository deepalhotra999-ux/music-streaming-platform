// Phase 25 — React binding for offline downloads.
//
// Owns one DownloadManager for the authenticated session, runs crash
// recovery on mount, and starts the connectivity-driven sync (queued
// event flush + grant revalidation). Unmounting (sign-out) stops the
// manager and the sync; downloads themselves persist on disk.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { getApiBaseUrl, type ApiClient, type TrackSummary } from '../api';
import { DownloadManager, type TrackMeta } from './downloadManager';
import { recoverInterruptedDownloads } from './metadataStore';
import type { DownloadRecord } from './types';
import { revalidateAll, type RevalidationSummary } from './revalidator';
import { startOfflineSync } from './sync';
import { offlineStorageUsage } from './storage';

export interface OfflineContextValue {
  downloads: DownloadRecord[];
  /** App-private offline storage in use, in bytes (null until measured). */
  usedBytes: number | null;
  downloadTrack: (trackId: string, meta: TrackMeta) => Promise<void>;
  /** Enqueue every track (duplicate-safe); used for album/playlist bulk download. */
  downloadTracks: (tracks: TrackSummary[]) => Promise<void>;
  pauseDownload: (trackId: string) => Promise<void>;
  resumeDownload: (trackId: string) => Promise<void>;
  cancelDownload: (trackId: string) => Promise<void>;
  retryDownload: (trackId: string) => Promise<void>;
  removeDownload: (trackId: string) => Promise<void>;
  /** Re-run revalidation against the server right now. */
  revalidateNow: () => Promise<RevalidationSummary>;
  refresh: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function useOffline(): OfflineContextValue {
  const value = useContext(OfflineContext);
  if (!value) {
    throw new Error('useOffline must be used within OfflineProvider');
  }
  return value;
}

interface OfflineProviderProps {
  children: ReactNode;
  api: ApiClient;
  baseUrl?: string;
}

export function OfflineProvider({ children, api, baseUrl }: OfflineProviderProps) {
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [usedBytes, setUsedBytes] = useState<number | null>(null);
  const managerRef = useRef<DownloadManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = new DownloadManager({
      api,
      baseUrl: baseUrl ?? getApiBaseUrl(),
      onChange: () => {
        void refreshRef.current();
      },
    });
  }
  const manager = managerRef.current;

  const refresh = useCallback(async () => {
    try {
      setDownloads(await manager.list());
      setUsedBytes(await offlineStorageUsage());
    } catch {
      // Storage reads are best-effort; the list stays as-is.
    }
  }, [manager]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let cancelled = false;
    // Crash recovery: interrupted downloads land in paused/verifying-safe
    // states; they do NOT auto-resume (the user may be on cellular).
    void recoverInterruptedDownloads().then(() => {
      if (!cancelled) void refresh();
    });
    const stopSync = startOfflineSync(api, {
      onEventsFlushed: () => {
        if (!cancelled) void refresh();
      },
      onRevalidated: () => {
        if (!cancelled) void refresh();
      },
    });
    return () => {
      cancelled = true;
      stopSync();
      void manager.stop();
    };
  }, [api, manager, refresh]);

  const value = useMemo<OfflineContextValue>(
    () => ({
      downloads,
      usedBytes,
      downloadTrack: (trackId, meta) => manager.enqueue(trackId, meta).then(() => undefined),
      downloadTracks: async (tracks) => {
        // Sequential enqueues: enqueue() is duplicate-safe, so re-tapping
        // "Download all" never duplicates work.
        for (const track of tracks) {
          await manager.enqueue(track.id, {
            title: track.title,
            artistName: track.artistName,
            albumTitle: track.albumTitle,
            durationMs: track.durationMs,
          });
        }
      },
      pauseDownload: (trackId) => manager.pause(trackId),
      resumeDownload: (trackId) => manager.resume(trackId),
      cancelDownload: (trackId) => manager.cancel(trackId).then(() => refresh()),
      retryDownload: (trackId) => manager.retry(trackId),
      removeDownload: (trackId) => manager.remove(trackId).then(() => refresh()),
      revalidateNow: () => revalidateAll(api).then((s) => (void refresh(), s)),
      refresh,
    }),
    [api, downloads, manager, refresh, usedBytes],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}
