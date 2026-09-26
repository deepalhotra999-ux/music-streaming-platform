// Phase 30 — online-only gate for commerce. Commerce requires connectivity:
// no offline carts, checkout, or order management. This hook reports whether
// the device is currently online; commerce screens render an offline notice
// instead of their normal content when disconnected.

import { useEffect, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => {
      // `isInternetReachable` can be null on first emit; fall back to isConnected.
      setOnline(state.isInternetReachable ?? state.isConnected ?? true);
    });
    void NetInfo.fetch().then((state) => {
      setOnline(state.isInternetReachable ?? state.isConnected ?? true);
    });
    return () => sub();
  }, []);

  return online;
}
