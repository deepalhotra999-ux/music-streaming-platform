// Phase 28 — RoomSocket tests: lifecycle, protocol, clock sync, reconnect.

import { ClockSync, RoomSocket, wsBaseUrl } from '../transport';
import type { WebSocketLike } from '../transport';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  url: string;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  readyState = 0;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  fail(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function makeSocket(overrides: Record<string, unknown> = {}) {
  FakeSocket.instances = [];
  const events: string[] = [];
  const socket = new RoomSocket(
    {
      baseUrl: 'ws://api.test',
      token: 'access-token',
      createSocket: (url) => new FakeSocket(url),
      now: () => 1_000_000,
      pingIntervalMs: 60_000,
      ...overrides,
    },
    {
      onConnectionChange: (state) => events.push(`conn:${state}`),
      onMessage: (message) => events.push(`msg:${message.type}`),
    },
  );
  return { socket, events };
}

describe('wsBaseUrl', () => {
  it('converts http(s) origins to ws(s)', () => {
    expect(wsBaseUrl('https://api.example.com/v1')).toBe('wss://api.example.com/v1');
    expect(wsBaseUrl('http://localhost:3000')).toBe('ws://localhost:3000');
    expect(wsBaseUrl('ws://already')).toBe('ws://already');
  });
});

describe('ClockSync', () => {
  it('estimates the median offset of recent samples', () => {
    const clock = new ClockSync();
    expect(clock.offsetMs).toBeNull();
    // offset = server - midpoint(clientSent, clientReceived)
    clock.addSample(1000, 1300, 1100); // offset 250
    clock.addSample(2000, 2250, 2100); // offset 200
    clock.addSample(3000, 3400, 3100); // offset 350
    expect(clock.offsetMs).toBe(250); // median
  });

  it('keeps at most 8 samples', () => {
    const clock = new ClockSync();
    for (let i = 0; i < 10; i += 1) {
      clock.addSample(i * 1000, i * 1000 + 500 + i, i * 1000 + 100);
    }
    expect(clock.sampleCount).toBe(8);
    expect(clock.offsetMs).not.toBeNull();
  });
});

describe('RoomSocket', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens the WS with the token in the query string', () => {
    const { socket } = makeSocket();
    socket.connect();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toBe('ws://api.test/v1/rooms/ws?token=access-token');
    socket.dispose();
  });

  it('emits ping with the client timestamp and feeds pong into the clock', () => {
    const { socket, events } = makeSocket();
    socket.connect();
    const fake = FakeSocket.instances[0];
    fake.open();
    // Fast-forward one ping interval.
    jest.advanceTimersByTime(60_000);
    const ping = JSON.parse(fake.sent[0]);
    expect(ping.type).toBe('ping');
    expect(ping.clientTime).toBe(1_000_000);
    fake.receive({
      type: 'pong',
      clientTime: 1_000_000,
      serverTime: new Date(1_000_500).toISOString(),
    });
    expect(socket.clock.sampleCount).toBe(1);
    expect(events).toContain('conn:open');
    socket.dispose();
  });

  it('ignores malformed messages without throwing', () => {
    const { socket, events } = makeSocket();
    socket.connect();
    const fake = FakeSocket.instances[0];
    fake.open();
    expect(() => {
      fake.onmessage?.({ data: 'not json' });
      fake.onmessage?.({ data: JSON.stringify({ nope: true }) });
      fake.onmessage?.({ data: JSON.stringify(null) });
    }).not.toThrow();
    expect(events.filter((e) => e.startsWith('msg:'))).toHaveLength(0);
    socket.dispose();
  });

  it('reconnects with backoff after an abnormal close', () => {
    const { socket } = makeSocket();
    socket.connect();
    expect(FakeSocket.instances).toHaveLength(1);
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].fail(1006);
    // First retry after 1s.
    jest.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    FakeSocket.instances[1].open();
    FakeSocket.instances[1].fail(1006);
    // Second retry after 2s.
    jest.advanceTimersByTime(2000);
    expect(FakeSocket.instances).toHaveLength(3);
    socket.dispose();
  });

  it('does not reconnect on 4401 so the app can refresh the token', () => {
    const { socket, events } = makeSocket();
    socket.connect();
    FakeSocket.instances[0].open();
    FakeSocket.instances[0].fail(4401, 'unauthorized');
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(events).toContain('conn:closed');
    socket.dispose();
  });

  it('manual disconnect stops reconnect attempts', () => {
    const { socket } = makeSocket();
    socket.connect();
    FakeSocket.instances[0].open();
    socket.disconnect();
    expect(FakeSocket.instances[0].closed).toBe(true);
    jest.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    socket.dispose();
  });

  it('dispose closes the socket and stops the ping timer', () => {
    const { socket } = makeSocket();
    socket.connect();
    FakeSocket.instances[0].open();
    // One immediate ping goes out on open (fast clock sample).
    const sentAtOpen = FakeSocket.instances[0].sent.length;
    expect(sentAtOpen).toBe(1);
    socket.dispose();
    expect(FakeSocket.instances[0].closed).toBe(true);
    // No further pings after dispose.
    jest.advanceTimersByTime(120_000);
    expect(FakeSocket.instances[0].sent).toHaveLength(sentAtOpen);
  });
});
