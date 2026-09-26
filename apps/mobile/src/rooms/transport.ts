// Phase 28 — WebSocket transport for synchronized listening rooms.
//
// Speaks the /v1/rooms/ws protocol: query-token auth, JSON messages,
// per-socket serialized handling server-side. This module owns the raw
// socket, ping/pong clock-offset estimation, and reconnect backoff.
// Room semantics (state application, commands, drift correction) live in
// the controller; this file never touches the playback engine.
//
// The WebSocket implementation is injected (global WebSocket on device,
// a fake in tests).

/** Client → server messages. */
export type RoomClientMessage =
  | { type: 'ping'; clientTime: number }
  | { type: 'room.join'; roomId: string }
  | { type: 'room.leave'; roomId: string }
  | { type: 'room.resync'; roomId: string }
  | {
      type: 'room.command';
      roomId: string;
      command: 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'queue';
      expectedRevision: number;
      positionMs?: number;
      trackIds?: string[];
      queueIndex?: number;
    };

/** Server → client messages. */
export type RoomServerMessage =
  | { type: 'pong'; clientTime: number; serverTime: string }
  | { type: 'room.state'; roomId: string; state: RoomWireState }
  | { type: 'room.event'; roomId: string; event: string; [key: string]: unknown }
  | { type: 'error'; code: string; message: string; roomId?: string; currentRevision?: number };

/**
 * Room state as carried on the wire. Mirrors the HTTP RoomState shape;
 * the controller converts it once.
 */
export interface RoomWireState {
  roomId: string;
  revision: number;
  status: 'ACTIVE' | 'ENDED';
  playbackState: 'PLAYING' | 'PAUSED';
  currentTrackId: string | null;
  currentTrack: RoomWireTrack | null;
  queueIndex: number;
  queue: RoomWireTrack[];
  positionMs: number;
  serverTime: string;
  role: 'HOST' | 'PARTICIPANT';
}

export interface RoomWireTrack {
  id: string;
  title: string;
  artistName: string;
  durationMs: number;
  artworkUrl: string | null;
}

export type SocketConnectionState = 'connecting' | 'open' | 'closed';

/** Minimal WebSocket surface the transport needs (RN + browsers + fakes). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface RoomSocketOptions {
  /** e.g. "ws://host:3000". The "/v1/rooms/ws?token=…" path is appended. */
  baseUrl: string;
  token: string;
  createSocket?: WebSocketFactory;
  /** Ping cadence for clock sync. Defaults to 10s. */
  pingIntervalMs?: number;
  /** Reconnect backoff schedule. Defaults to [1s, 2s, 5s, 10s, 30s]. */
  backoffMs?: number[];
  now?: () => number;
}

const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * Median-of-recent clock offset estimator.
 *
 * offset = serverTime - localTime, so serverNow ≈ Date.now() + offset.
 * Samples come from pong round trips; the median of the last 8 rejects
 * one-sided network jitter without chasing it.
 */
export class ClockSync {
  private readonly samples: number[] = [];
  constructor(private readonly maxSamples = 8) {}

  /** Record a pong: clientTime is the echoed ping stamp. */
  addSample(clientTime: number, serverTimeMs: number, receivedAtMs: number): void {
    const offset = serverTimeMs - (clientTime + receivedAtMs) / 2;
    this.samples.push(offset);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /** Estimated serverTime - localTime in ms, or null before any sample. */
  get offsetMs(): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

export interface RoomSocketEvents {
  onConnectionChange?: (state: SocketConnectionState) => void;
  onMessage?: (message: RoomServerMessage) => void;
  /** Fired when the socket closes and a reconnect is scheduled. */
  onReconnectScheduled?: (attempt: number, delayMs: number) => void;
}

/**
 * A single logical connection to /v1/rooms/ws with automatic reconnect.
 *
 * Reconnect reuses the same access token; when the token itself is dead
 * the server closes with 4401 and the transport stops retrying so the
 * controller can refresh credentials and reconnect explicitly.
 */
export class RoomSocket {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly createSocket: WebSocketFactory;
  private readonly pingIntervalMs: number;
  private readonly backoffMs: number[];
  private readonly now: () => number;
  private readonly events: RoomSocketEvents;

  private socket: WebSocketLike | null = null;
  private connectionState: SocketConnectionState = 'closed';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** Set when the server rejects the token: retrying is pointless. */
  private authFailed = false;

  readonly clock = new ClockSync();

  constructor(options: RoomSocketOptions, events: RoomSocketEvents = {}) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.createSocket =
      options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.pingIntervalMs = options.pingIntervalMs ?? 10_000;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.now = options.now ?? (() => Date.now());
    this.events = events;
  }

  get state(): SocketConnectionState {
    return this.connectionState;
  }

  /** Open the connection (or re-open after a manual close). */
  connect(): void {
    if (this.disposed || this.authFailed) return;
    if (this.socket) return; // already connecting/open
    this.setState('connecting');
    const url = `${this.baseUrl}/v1/rooms/ws?token=${encodeURIComponent(this.token)}`;
    const socket = this.createSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.setState('open');
      this.sendPing();
      this.pingTimer = setInterval(() => this.sendPing(), this.pingIntervalMs);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleRaw(event.data);
    };
    socket.onerror = () => {
      // The close handler below drives reconnect; errors alone are noise.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.disposed) {
        this.setState('closed');
        return;
      }
      // 4401 = the token is dead; refreshing it is the controller's job.
      if (event.code === 4401) {
        this.authFailed = true;
        this.setState('closed');
        return;
      }
      this.setState('closed');
      this.scheduleReconnect();
    };
  }

  /** Close the socket and cancel any pending reconnect. */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    // Null the handlers first so the close event doesn't schedule a reconnect.
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already gone; nothing to do.
      }
    }
    this.setState('closed');
  }

  /** Permanent teardown. */
  dispose(): void {
    this.disposed = true;
    this.disconnect();
  }

  send(message: RoomClientMessage): void {
    if (this.connectionState !== 'open' || !this.socket) {
      return; // Messages are only meaningful on a live socket.
    }
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // A send race with a dying socket; the reconnect path recovers.
    }
  }

  private sendPing(): void {
    this.send({ type: 'ping', clientTime: this.now() });
  }

  private handleRaw(data: string): void {
    let message: RoomServerMessage;
    try {
      message = JSON.parse(data) as RoomServerMessage;
    } catch {
      return; // Not our protocol; ignore.
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'pong') {
      const serverMs = Date.parse(message.serverTime);
      if (Number.isFinite(serverMs)) {
        this.clock.addSample(message.clientTime, serverMs, this.now());
      }
    }
    this.events.onMessage?.(message);
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.authFailed) return;
    const delay = this.backoffMs[
      Math.min(this.reconnectAttempt, this.backoffMs.length - 1)
    ] as number;
    this.reconnectAttempt += 1;
    this.events.onReconnectScheduled?.(this.reconnectAttempt, delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: SocketConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.events.onConnectionChange?.(state);
  }
}

/** Build the WS origin from the HTTP API origin (http→ws, https→wss). */
export function wsBaseUrl(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/\/+$/, '').replace(/^http/, 'ws');
}
