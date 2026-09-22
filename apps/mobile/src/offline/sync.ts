// Phase 25 — connectivity-driven offline sync.
//
// When the device regains connectivity: flush queued offline play events,
// then revalidate download authorizations. Also runs once at startup.
// Never runs while offline: revalidation must hit the server, and the
// local authorization window must never be extended without it.

import NetInfo from '@react-native-community/netinfo';
import type { ApiClient } from '../api';
import { flushOfflineEvents } from './eventQueue';
import { revalidateAll } from './revalidator';

export interface OfflineSyncCallbacks {
  onEventsFlushed?: (uploaded: number, rejected: number) => void;
  onRevalidated?: (renewed: number, invalidated: number) => void;
  onSyncError?: (error: unknown) => void;
}

export function startOfflineSync(api: ApiClient, callbacks: OfflineSyncCallbacks = {}): () => void {
  let syncing = false;
  let wasOnline: boolean | null = null;

  const runSync = async (): Promise<void> => {
    if (syncing) return;
    syncing = true;
    try {
      const flush = await flushOfflineEvents(api);
      callbacks.onEventsFlushed?.(flush.uploaded, flush.rejected.length);
      if (!flush.retryable || flush.uploaded > 0 || flush.rejected.length > 0) {
        // Only revalidate when the event pipeline is settled; a hard
        // network failure means revalidation would fail too.
        const summary = await revalidateAll(api);
        callbacks.onRevalidated?.(summary.renewed, summary.invalidated);
      }
    } catch (error) {
      callbacks.onSyncError?.(error);
    } finally {
      syncing = false;
    }
  };

  const unsubscribe = NetInfo.addEventListener((state) => {
    const online = state.isConnected === true && state.isInternetReachable !== false;
    // wasOnline starts null: the first event (NetInfo fires the current
    // state immediately on subscribe) triggers the startup sync when the
    // device is already online; later false→true transitions cover
    // regained connectivity.
    if (wasOnline !== true && online) {
      void runSync();
    }
    wasOnline = online;
  });

  return () => {
    unsubscribe();
  };
}
