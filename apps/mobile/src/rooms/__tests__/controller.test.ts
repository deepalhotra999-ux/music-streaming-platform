// Phase 28 — RoomSession tests: state application, host advance, drift,
// revision handling, and room-mode engine semantics.

import { RoomSession } from '../controller';
import type { RoomState, RoomTrack } from '../../api';
import type { EngineSnapshot, PlaybackEngine, QueueTrack } from '../../playback';
import type { WebSocketLike } from '../transport';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function roomTrack(id: string): RoomTrack {
  return {
    id,
    title: `Title ${id}`,
    artistName: 'Artist',
    artworkUrl: null,
    durationMs: 180_000,
  };
}

function makeRoomState(overrides: Partial<RoomState> = {}): RoomState {
  const queue = [roomTrack('t1'), roomTrack('t2'), roomTrack('t3')];
  return {
    roomId: 'room-1',
    revision: 3,
    status: 'ACTIVE',
    playbackState: 'PLAYING',
    currentTrackId: 't1',
    currentTrack: queue[0],
    queueIndex: 0,
    queue,
    positionMs: 10_000,
    serverTime: new Date(1_000_000).toISOString(),
    role: 'HOST',
    ...overrides,
  };
}

class FakeEngine {
  listeners = new Set<() => void>();
  snapshot: EngineSnapshot = {
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
    repeatMode: 'all',
    shuffle: false,
  };
  calls: string[] = [];
  seekTargets: number[] = [];
  forceOnlineValue = false;

  getSnapshot(): EngineSnapshot {
    return this.snapshot;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async setQueue(tracks: QueueTrack[], index: number): Promise<void> {
    this.calls.push('setQueue');
    this.snapshot = {
      ...this.snapshot,
      queue: tracks,
      trackIndex: index,
      track: tracks[index] ?? null,
      state: 'playing',
      positionMs: 0,
    };
    this.emit();
  }
  async seekTo(ms: number): Promise<void> {
    this.calls.push('seekTo');
    this.seekTargets.push(ms);
    this.snapshot = { ...this.snapshot, positionMs: ms };
  }
  play(): void {
    this.calls.push('play');
    this.snapshot = { ...this.snapshot, state: 'playing' };
    this.emit();
  }
  pause(): void {
    this.calls.push('pause');
    this.snapshot = { ...this.snapshot, state: 'paused' };
    this.emit();
  }
  setRepeatMode(mode: 'off' | 'all' | 'one'): void {
    this.calls.push(`setRepeatMode:${mode}`);
    this.snapshot = { ...this.snapshot, repeatMode: mode };
  }
  setForceOnline(force: boolean): void {
    this.calls.push(`setForceOnline:${force}`);
    this.forceOnlineValue = force;
  }
  /** Simulate the engine moving on its own (natural advance, user action). */
  driveTo(trackId: string): void {
    const index = this.snapshot.queue.findIndex((t) => t.trackId === trackId);
    this.snapshot = {
      ...this.snapshot,
      trackIndex: index,
      track: this.snapshot.queue[index] ?? null,
      state: 'playing',
      positionMs: 0,
    };
    this.emit();
  }
  setPlayingState(state: EngineSnapshot['state'], positionMs: number): void {
    this.snapshot = { ...this.snapshot, state, positionMs };
    this.emit();
  }
  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

// NOTE: jest.useFakeTimers() also fakes setImmediate, so capture the real
// one for flushing promise chains.
const realSetImmediate = setImmediate;

function flush(): Promise<void> {
  return new Promise((resolve) => realSetImmediate(resolve));
}

describe('RoomSession', () => {
  let nowMs: number;

  beforeEach(() => {
    jest.useFakeTimers();
    nowMs = 1_000_000;
    FakeSocket.instances = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function setup(role: 'HOST' | 'PARTICIPANT' = 'HOST') {
    const engine = new FakeEngine();
    const api = {
      get: jest.fn(async (path: string) => {
        if (path === '/v1/rooms/room-1') return makeRoomState({ role });
        if (path === '/v1/rooms/room-1/members') return { data: [] };
        throw new Error(`unexpected GET ${path}`);
      }),
      post: jest.fn(async (path: string) => {
        if (path === '/v1/rooms') return makeRoomState({ role });
        throw new Error(`unexpected POST ${path}`);
      }),
      delete: jest.fn(async () => ({})),
    };
    const statuses: string[] = [];
    const session = new RoomSession(
      {
        // Cast: the test double only implements the surface rooms.ts uses.
        api: api as never,
        engine: engine as unknown as PlaybackEngine,
        baseUrl: 'https://api.test',
        getAccessToken: () => 'token',
        createSocket: (url) => new FakeSocket(url),
        now: () => nowMs,
      },
      { onStatusChange: (s) => statuses.push(s) },
    );
    return { engine, api, session, statuses };
  }

  async function joinLive(session: RoomSession) {
    await session.joinAsHost({ trackIds: ['t1', 't2', 't3'] });
    await flush();
    const socket = FakeSocket.instances[0];
    socket.open();
    await flush();
    return socket;
  }

  it('applies authoritative state to the engine on join', async () => {
    const { engine, session, statuses } = setup();
    const socket = await joinLive(session);
    expect(engine.calls).toContain('setQueue');
    expect(engine.calls).toContain('setForceOnline:true');
    expect(engine.calls).toContain('setRepeatMode:off');
    // Room join is announced over the socket.
    const join = JSON.parse(socket.sent.find((s) => JSON.parse(s).type === 'room.join')!);
    expect(join.roomId).toBe('room-1');
    expect(statuses).toContain('live');
    session.dispose();
  });

  it('ignores stale and duplicate revisions', async () => {
    const { engine, session } = setup();
    const socket = await joinLive(session);
    const setQueueCalls = engine.calls.filter((c) => c === 'setQueue').length;
    socket.receive({
      type: 'room.state',
      roomId: 'room-1',
      state: {
        roomId: 'room-1',
        revision: 3, // duplicate
        status: 'ACTIVE',
        playbackState: 'PAUSED',
        currentTrackId: 't1',
        currentTrack: roomTrack('t1'),
        queueIndex: 0,
        queue: [roomTrack('t1')],
        positionMs: 0,
        serverTime: new Date(nowMs).toISOString(),
        role: 'HOST',
      },
    });
    await flush();
    expect(engine.calls.filter((c) => c === 'setQueue').length).toBe(setQueueCalls);
    session.dispose();
  });

  it('host natural advance sends a next command', async () => {
    const { engine, session } = setup('HOST');
    const socket = await joinLive(session);
    // The engine auto-advances to the next queue track on its own.
    engine.driveTo('t2');
    await flush();
    const commands = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'room.command');
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe('next');
    session.dispose();
  });

  it('participants never send room commands', async () => {
    const { session } = setup('PARTICIPANT');
    const socket = await joinLive(session);
    session.hostPlay();
    session.hostPause();
    session.hostNext();
    session.hostSeek(5000);
    await flush();
    const commands = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'room.command');
    expect(commands).toHaveLength(0);
    session.dispose();
  });

  it('host commands include the last applied revision', async () => {
    const { session } = setup('HOST');
    const socket = await joinLive(session);
    session.hostPause();
    await flush();
    const command = JSON.parse(socket.sent.find((s) => JSON.parse(s).command === 'pause')!);
    expect(command.expectedRevision).toBe(3);
    session.dispose();
  });

  it('corrects drift when the engine position diverges', async () => {
    const { engine, session } = setup('HOST');
    await joinLive(session);
    engine.seekTargets.length = 0;
    // Engine is playing but 60s behind the room's extrapolated position.
    engine.setPlayingState('playing', 0);
    nowMs += 2000; // drift tick fires
    jest.advanceTimersByTime(2000);
    await flush();
    expect(engine.seekTargets.length).toBeGreaterThan(0);
    // Expected ≈ positionMs(10_000) + elapsed(2_000) = 12_000.
    expect(engine.seekTargets[engine.seekTargets.length - 1]).toBeGreaterThanOrEqual(11_900);
    session.dispose();
  });

  it('leaves a deliberate local pause alone (manual resync instead)', async () => {
    const { engine, session } = setup('HOST');
    await joinLive(session);
    engine.calls.length = 0;
    // Long after the last room state, the user pauses locally.
    nowMs += 60_000;
    engine.setPlayingState('paused', 30_000);
    jest.advanceTimersByTime(4000);
    await flush();
    expect(engine.calls).not.toContain('play');
    session.dispose();
  });

  it('room_ended transitions the session to ended', async () => {
    const { session, statuses } = setup('HOST');
    const socket = await joinLive(session);
    socket.receive({ type: 'room.event', roomId: 'room-1', event: 'room_ended' });
    await flush();
    expect(statuses).toContain('ended');
    expect(session.connectionStatus).toBe('ended');
    session.dispose();
  });

  it('leave pauses the engine, restores repeat, and exits room mode', async () => {
    const { engine, session } = setup('HOST');
    await joinLive(session);
    await session.leave();
    expect(engine.calls).toContain('pause');
    expect(engine.calls).toContain('setRepeatMode:all'); // saved value restored
    expect(engine.calls).toContain('setForceOnline:false');
    expect(session.connectionStatus).toBe('idle');
    session.dispose();
  });

  it('resync re-fetches authoritative state', async () => {
    const { api, session } = setup('HOST');
    await joinLive(session);
    const getsBefore = (api.get as jest.Mock).mock.calls.length;
    await session.resync();
    const getsAfter = (api.get as jest.Mock).mock.calls.length;
    expect(getsAfter).toBeGreaterThan(getsBefore);
    session.dispose();
  });

  it('applies PAUSED room state by pausing the engine', async () => {
    const { engine, session } = setup('HOST');
    const socket = await joinLive(session);
    engine.calls.length = 0;
    socket.receive({
      type: 'room.state',
      roomId: 'room-1',
      state: {
        roomId: 'room-1',
        revision: 4,
        status: 'ACTIVE',
        playbackState: 'PAUSED',
        currentTrackId: 't1',
        currentTrack: roomTrack('t1'),
        queueIndex: 0,
        queue: [roomTrack('t1'), roomTrack('t2'), roomTrack('t3')],
        positionMs: 42_000,
        serverTime: new Date(nowMs).toISOString(),
        role: 'HOST',
      },
    });
    await flush();
    // Same track: engine pauses and seeks to the room position.
    expect(engine.calls).toContain('pause');
    session.dispose();
  });
});
