// Phase 27 — useOnlineStatus: mirrors the offline module's connectivity
// semantics (connected AND internet reachable).

import { act, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { isOnlineState, useOnlineStatus } from '../useOnlineStatus';

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

function emit(state: { isConnected: boolean | null; isInternetReachable: boolean | null }) {
  for (const listener of [...listeners]) listener(state);
}

function Probe() {
  const online = useOnlineStatus();
  return <Text testID="online">{online ? 'yes' : 'no'}</Text>;
}

beforeEach(() => {
  listeners.clear();
  mockAddEventListener.mockClear();
});

describe('isOnlineState', () => {
  it('is online only when connected and the internet is reachable', () => {
    expect(isOnlineState({ isConnected: true, isInternetReachable: true })).toBe(true);
    // Unknown reachability does not count as offline (matches sync.ts).
    expect(isOnlineState({ isConnected: true, isInternetReachable: null })).toBe(true);
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false);
    expect(isOnlineState({ isConnected: false, isInternetReachable: true })).toBe(false);
    expect(isOnlineState({ isConnected: null, isInternetReachable: null })).toBe(false);
  });
});

describe('useOnlineStatus', () => {
  it('starts optimistic and follows NetInfo events', async () => {
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('online').props.children).toBe('yes');

    await act(async () => {
      emit({ isConnected: false, isInternetReachable: false });
    });
    await waitFor(() => expect(getByTestId('online').props.children).toBe('no'));

    await act(async () => {
      emit({ isConnected: true, isInternetReachable: true });
    });
    await waitFor(() => expect(getByTestId('online').props.children).toBe('yes'));
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<Probe />);
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
