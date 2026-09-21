// Shared fake AudioDriver for playback engine tests (unit + live).
// Pure TypeScript: no expo-audio import, so it also runs in the node-based
// live suite. Mirrors the real adapter's observable behavior: load()
// publishes its initial status synchronously, and exactly one "player" is
// alive at a time (load without a matching destroy is a test failure).

import type { AudioDriver, DriverStatus } from '../types';

export const EMPTY_STATUS: DriverStatus = {
  isLoaded: false,
  isBuffering: false,
  playing: false,
  didJustFinish: false,
  currentTimeSec: 0,
  durationSec: 0,
  error: null,
};

export class FakeAudioDriver implements AudioDriver {
  status: DriverStatus = { ...EMPTY_STATUS };
  loadCalls: string[] = [];
  playCalls = 0;
  pauseCalls = 0;
  seekCalls: number[] = [];
  destroyCalls = 0;
  initializeCalls = 0;
  /** Highest number of players alive at once; must never exceed 1. */
  maxConcurrentPlayers = 0;
  loadError: string | null = null;
  seekError: string | null = null;

  private listener: ((status: DriverStatus) => void) | null = null;
  private livePlayers = 0;
  private readonly onEvent: ((name: string) => void) | null;

  constructor(onEvent?: (name: string) => void) {
    this.onEvent = onEvent ?? null;
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  async load(uri: string): Promise<void> {
    this.loadCalls.push(uri);
    this.onEvent?.(`load:${uri}`);
    if (this.loadError) {
      throw new Error(this.loadError);
    }
    this.livePlayers += 1;
    this.maxConcurrentPlayers = Math.max(this.maxConcurrentPlayers, this.livePlayers);
    // Like the expo adapter, publish the initial status synchronously.
    this.publish({ ...EMPTY_STATUS, isLoaded: true });
  }

  play(): void {
    this.playCalls += 1;
    this.publish({ ...this.status, playing: true });
  }

  pause(): void {
    this.pauseCalls += 1;
    this.publish({ ...this.status, playing: false });
  }

  async seekTo(positionMs: number): Promise<void> {
    if (this.seekError) {
      throw new Error(this.seekError);
    }
    this.seekCalls.push(positionMs);
    this.publish({ ...this.status, currentTimeSec: positionMs / 1000 });
  }

  getStatus(): DriverStatus {
    return this.status;
  }

  onStatusChange(listener: (status: DriverStatus) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) {
        this.listener = null;
      }
    };
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.onEvent?.('destroy');
    if (this.livePlayers > 0) {
      this.livePlayers -= 1;
    }
    this.status = { ...EMPTY_STATUS };
  }

  /** Test helper: emit a driver status update as the native player would. */
  emit(partial: Partial<DriverStatus>): void {
    this.publish({ ...this.status, ...partial });
  }

  private publish(status: DriverStatus): void {
    this.status = status;
    this.listener?.(status);
  }
}
