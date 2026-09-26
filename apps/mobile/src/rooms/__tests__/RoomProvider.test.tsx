// Phase 28 — RoomProvider tests: session lifecycle wiring through the
// provider, host exposure, and the connectivity fast-track.

import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { RoomState } from '../../api';

const mockRegistry = {
  engine: null as unknown,
  listeners: new Set<() => void>(),
};

jest.mock('../../playback/engineRegistry', () => ({
  getActiveEngine: () => mockRegistry.engine,
  subscribeEngine: (listener: () => void) => {
    mockRegistry.listeners.add(listener);
    return () => {
      mockRegistry.listeners.delete(listener);
    };
  },
}));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => jest.fn()) },
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  open(): void {
    this.onopen?.({});
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).WebSocket = FakeWebSocket;

// Import after the mocks so the provider picks them up.
import { RoomProvider, useRoom } from '../RoomProvider';

const NetInfo = jest.requireMock('@react-native-community/netinfo').default;

function makeRoomState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 'room-1',
    revision: 1,
    status: 'ACTIVE',
    playbackState: 'PAUSED',
    currentTrackId: null,
    currentTrack: null,
    queueIndex: 0,
    queue: [],
    positionMs: 0,
    serverTime: new Date().toISOString(),
    role: 'HOST',
    ...overrides,
  };
}

function fakeEngine() {
  return {
    getSnapshot: () => ({
      state: 'idle',
      queue: [],
      trackIndex: -1,
      track: null,
      positionMs: 0,
      durationMs: 0,
      isBuffering: false,
      error: null,
      locked: false,
      isOfflinePlayback: false,
      canNext: false,
      canPrevious: false,
      repeatMode: 'off',
      shuffle: false,
    }),
    subscribe: () => () => undefined,
    setQueue: jest.fn(async () => undefined),
    seekTo: jest.fn(async () => undefined),
    play: jest.fn(),
    pause: jest.fn(),
    setRepeatMode: jest.fn(),
    setForceOnline: jest.fn(),
  };
}

function setupProvider() {
  FakeWebSocket.instances = [];
  mockRegistry.engine = fakeEngine();
  const api = {
    get: jest.fn(async (path: string) => {
      if (path === '/v1/rooms/room-1') return makeRoomState();
      if (path === '/v1/rooms/room-1/members') return { data: [] };
      throw new Error(`unexpected GET ${path}`);
    }),
    post: jest.fn(async (path: string) => {
      if (path === '/v1/rooms') return makeRoomState();
      if (path === '/v1/rooms/room-1/leave') return undefined;
      throw new Error(`unexpected POST ${path}`);
    }),
    delete: jest.fn(async () => undefined),
  };

  function Probe() {
    const room = useRoom();
    return (
      <>
        <Text testID="status">{room.status}</Text>
        <Text testID="isHost">{room.isHost ? 'yes' : 'no'}</Text>
      </>
    );
  }

  const captured: { current: ReturnType<typeof useRoom> | null } = { current: null };
  function Capture() {
    captured.current = useRoom();
    return null;
  }

  render(
    <RoomProvider api={api as never} getAccessToken={() => 'token'} baseUrl="https://api.test">
      <Probe />
      <Capture />
    </RoomProvider>,
  );
  return { api, captured };
}

describe('RoomProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegistry.engine = null;
    mockRegistry.listeners.clear();
  });

  it('starts idle with no host role', () => {
    setupProvider();
    expect(screen.getByTestId('status').children).toEqual(['idle']);
    expect(screen.getByTestId('isHost').children).toEqual(['no']);
  });

  it('registers a NetInfo listener for the connectivity fast-track', () => {
    setupProvider();
    expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('joinAsHost drives the session to live and exposes host role', async () => {
    const { captured } = setupProvider();
    await act(async () => {
      await captured.current!.joinAsHost({ trackIds: ['t1'] });
    });
    expect(screen.getByTestId('status').children).toEqual(['connecting']);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain('/v1/rooms/ws?token=token');

    await act(async () => {
      FakeWebSocket.instances[0].open();
    });
    expect(screen.getByTestId('status').children).toEqual(['live']);
    expect(screen.getByTestId('isHost').children).toEqual(['yes']);
  });

  it('leave returns the provider to idle', async () => {
    const { captured } = setupProvider();
    await act(async () => {
      await captured.current!.joinAsHost({ trackIds: ['t1'] });
    });
    await act(async () => {
      FakeWebSocket.instances[0].open();
    });
    expect(screen.getByTestId('status').children).toEqual(['live']);
    await act(async () => {
      await captured.current!.leave();
    });
    expect(screen.getByTestId('status').children).toEqual(['idle']);
    expect(screen.getByTestId('isHost').children).toEqual(['no']);
  });

  it('useRoom throws outside the provider', () => {
    function NoProvider() {
      useRoom();
      return null;
    }
    expect(() => render(<NoProvider />)).toThrow('useRoom must be used within RoomProvider');
  });
});
