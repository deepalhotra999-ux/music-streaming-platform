// Phase 27 — shared connectivity signal for gating collaborative editing.
//
// Same semantics as the offline sync module (src/offline/sync.ts): the
// device is "online" when it is connected AND the internet is reachable.
// NetInfo fires the current state immediately on subscribe, so the
// initial `true` is only a placeholder until the first event lands.
// Collaborative mutations are disabled while offline; offline downloads
// and playback (Phase 25) are unaffected.

import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

interface NetState {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}

/** Pure connectivity predicate, exported for unit tests. */
export function isOnlineState(state: NetState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOnline(isOnlineState(state));
    });
    return unsubscribe;
  }, []);

  return online;
}
