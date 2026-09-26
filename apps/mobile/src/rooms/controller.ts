// Phase 28 — RoomSession: the synchronized-listening controller.
//
// Drives the ONE shared PlaybackEngine from server-authoritative room
// state received over the WebSocket transport. The engine is never
// rewritten or forked: it keeps minting its own per-listener Phase 7
// playback sessions and play events (START/HEARTBEAT/COMPLETE/ERROR),
// so every listener retains individual session/entitlement/royalty
// semantics. The controller only translates room state → engine calls.
//
// Authority model:
// - Room state is authoritative. Remote state is applied to the engine;
//   engine snapshots never flow upward, except for one case:
// - The HOST's natural track completion: the engine auto-advances its
//   local queue on didJustFinish; the controller observes the track
//   change and sends a `next` room command so every listener advances
//   together. The COMPLETE event the engine already reported for the
//   host's own session is real (not fabricated).
//
// Feedback-loop suppression: `lastAppliedTrackId` is updated BEFORE the
// engine call that changes the track, so the snapshot observer can tell
// "the engine moved because I applied remote state" (ids match → ignore)
// from "the engine moved on its own" (track is the next queue entry → the
// host's natural advance → send `next`).
//
// Drift policy: while PLAYING, the expected position is
//   positionMs + (localNow + clockOffset - serverTime).
// A position deviation over DRIFT_CORRECT_MS (3s) triggers a seek. A
// locally-paused engine against a PLAYING room is resumed only within a
// short window after a room state was applied (our own apply pipeline
// glitching, not the user); a deliberate local pause stays paused and the
// room screen offers a manual resync.

import type { ApiClient } from '../api';
import {
  createRoom,
  endRoom as apiEndRoom,
  getRoomState,
  joinRoom,
  leaveRoom as apiLeaveRoom,
  listRoomMembers,
  type CreateRoomInput,
  type RoomMember,
  type RoomState,
  type RoomTrack,
} from '../api';
import type { PlaybackEngine } from '../playback/PlaybackEngine';
import type { QueueTrack } from '../playback/types';
import { ClockSync, RoomSocket, wsBaseUrl } from './transport';
import type { RoomServerMessage, RoomWireState, WebSocketFactory } from './transport';

export type RoomConnectionStatus =
  'idle' | 'joining' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error';

/** Position deviation that triggers a corrective seek. */
export const DRIFT_CORRECT_MS = 3000;
/** Same-track position delta applied immediately during state apply. */
export const APPLY_SEEK_MS = 1500;
/** How often the drift corrector runs. */
export const DRIFT_TICK_MS = 2000;
/** A locally-paused engine is auto-resumed only within this window. */
export const RESUME_WINDOW_MS = 10_000;
/** Give up reconnecting after this long, then leave the room. */
export const RECONNECT_GIVE_UP_MS = 60_000;

export interface RoomSessionEvents {
  onStatusChange?: (status: RoomConnectionStatus) => void;
  onRoomChange?: (state: RoomState | null) => void;
  onMembersChange?: (members: RoomMember[]) => void;
  onError?: (message: string) => void;
}

export interface RoomSessionOptions {
  api: ApiClient;
  engine: PlaybackEngine;
  /** HTTP API origin; the WS origin is derived (http→ws). */
  baseUrl: string;
  /** Returns the current access token for the WS query auth. */
  getAccessToken: () => string | null;
  /** Test seam for the WebSocket implementation. */
  createSocket?: WebSocketFactory;
  now?: () => number;
}

function toQueueTrack(track: RoomTrack): QueueTrack {
  return {
    trackId: track.id,
    title: track.title,
    artistName: track.artistName,
    artworkUrl: track.artworkUrl,
    durationMs: track.durationMs,
  };
}

function wireToState(wire: RoomWireState): RoomState {
  return {
    roomId: wire.roomId,
    revision: wire.revision,
    status: wire.status,
    playbackState: wire.playbackState,
    currentTrackId: wire.currentTrackId,
    currentTrack: wire.currentTrack,
    queueIndex: wire.queueIndex,
    queue: wire.queue,
    positionMs: wire.positionMs,
    serverTime: wire.serverTime,
    role: wire.role,
  };
}

export class RoomSession {
  private readonly api: ApiClient;
  private readonly engine: PlaybackEngine;
  private readonly baseUrl: string;
  private readonly getAccessToken: () => string | null;
  private readonly createSocket?: WebSocketFactory;
  private readonly now: () => number;
  private readonly events: RoomSessionEvents;

  private status: RoomConnectionStatus = 'idle';
  private room: RoomState | null = null;
  private members: RoomMember[] = [];
  private socket: RoomSocket | null = null;
  private unsubscribeEngine: (() => void) | null = null;

  /** Highest applied revision; stale/duplicate states are ignored. */
  private lastRevision = -1;
  /** Local clock offset estimate (serverTime - localTime). */
  private readonly clock = new ClockSync();
  /** When the last state was received (local ms). */
  private lastStateAt = 0;
  /** Track id the engine was last driven to (feedback-loop suppression). */
  private lastAppliedTrackId: string | null = null;
  /** Whether the host already paused the room at natural queue end. */
  private endPauseSent = false;
  /** Engine repeat mode saved on join, restored on leave. */
  private savedRepeatMode: 'off' | 'all' | 'one' = 'off';
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private giveUpTimer: ReturnType<typeof setTimeout> | null = null;
  private membersRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: RoomSessionOptions, events: RoomSessionEvents = {}) {
    this.api = options.api;
    this.engine = options.engine;
    this.baseUrl = options.baseUrl;
    this.getAccessToken = options.getAccessToken;
    this.createSocket = options.createSocket;
    this.now = options.now ?? (() => Date.now());
    this.events = events;
  }

  get connectionStatus(): RoomConnectionStatus {
    return this.status;
  }

  get roomState(): RoomState | null {
    return this.room;
  }

  get roomMembers(): RoomMember[] {
    return this.members.slice();
  }

  get isHost(): boolean {
    return this.room?.role === 'HOST';
  }

  get roomId(): string | null {
    return this.room?.roomId ?? null;
  }

  // -- joining ---------------------------------------------------------------

  /** Create a room as host, then attach the sync session. */
  async joinAsHost(input: CreateRoomInput): Promise<void> {
    this.setStatus('joining');
    try {
      const state = await createRoom(this.api, input);
      await this.attach(state);
    } catch (error) {
      this.setStatus('error');
      this.events.onError?.(errorMessage(error));
      throw error;
    }
  }

  /** Join via a single-use invitation token, then attach. */
  async joinWithToken(roomId: string, token: string): Promise<void> {
    this.setStatus('joining');
    try {
      const state = await joinRoom(this.api, roomId, token);
      await this.attach(state);
    } catch (error) {
      this.setStatus('error');
      this.events.onError?.(errorMessage(error));
      throw error;
    }
  }

  private async attach(initial: RoomState): Promise<void> {
    if (this.disposed) return;
    // Room mode owns transport: repeat would fight the room queue at its
    // end (the engine would wrap instead of reaching 'ended').
    this.savedRepeatMode = this.engine.getSnapshot().repeatMode;
    this.engine.setRepeatMode('off');
    // Room mode is online-only: every listener mints an ordinary Phase 7
    // streaming session (per-listener sessions/events/royalties). Offline
    // downloads keep working for personal playback outside rooms.
    this.engine.setForceOnline(true);
    try {
      await this.attachInner(initial);
    } catch (error) {
      // A failed join must not leave the engine stuck in room mode.
      this.engine.setForceOnline(false);
      this.engine.setRepeatMode(this.savedRepeatMode);
      throw error;
    }
  }

  private async attachInner(initial: RoomState): Promise<void> {
    this.unsubscribeEngine = this.engine.subscribe(() => this.onEngineSnapshot());

    this.setStatus('connecting');
    // The HTTP round trip also refreshes a stale access token through the
    // client's 401 hook before we read it for the WS query auth.
    const fresh = await getRoomState(this.api, initial.roomId).catch(() => initial);
    this.applyWireState(wireFromState(fresh));
    await this.refreshMembers().catch(() => undefined);

    const token = this.getAccessToken();
    if (!token) {
      throw new Error('Not signed in.');
    }
    const socket = new RoomSocket(
      {
        baseUrl: wsBaseUrl(this.baseUrl),
        token,
        createSocket: this.createSocket,
        now: this.now,
      },
      {
        onConnectionChange: (state) => {
          if (state === 'open') {
            this.clearGiveUp();
            this.setStatus('live');
            this.socket?.send({ type: 'room.join', roomId: initial.roomId });
          } else if (state === 'closed' && !this.disposed) {
            if (this.status === 'live' || this.status === 'connecting') {
              this.setStatus('reconnecting');
              this.armGiveUp();
            }
          }
        },
        onMessage: (message) => this.onSocketMessage(message),
      },
    );
    this.socket = socket;
    socket.connect();
    this.driftTimer = setInterval(() => this.driftTick(), DRIFT_TICK_MS);
  }

  // -- leaving -----------------------------------------------------------------

  /** Leave the room: detach the engine and restore local control. */
  async leave(): Promise<void> {
    const roomId = this.room?.roomId;
    this.teardown();
    if (roomId) {
      // Best effort: the socket may already be dead.
      try {
        await apiLeaveRoom(this.api, roomId);
      } catch {
        // Leaving is local-first; the server row is idempotent.
      }
    }
    this.setStatus('idle');
  }

  /** Host only: terminate the room for everyone. */
  async endRoom(): Promise<void> {
    const roomId = this.room?.roomId;
    if (!roomId || !this.isHost) return;
    await apiEndRoom(this.api, roomId);
    // The room_ended broadcast confirms it; handle locally too in case the
    // socket is down.
    this.handleRoomEnded();
  }

  /** The network is gone: fast-track the reconnect give-up. */
  notifyNetworkLost(): void {
    if (this.status === 'reconnecting' || this.status === 'connecting') {
      void this.leaveDueToError('Connection lost. You left the room.');
    }
  }

  /** Manual resync: re-fetch authoritative state and re-apply. */
  async resync(): Promise<void> {
    const roomId = this.room?.roomId;
    if (!roomId) return;
    try {
      const state = await getRoomState(this.api, roomId);
      this.applyWireState(wireFromState(state));
      this.socket?.send({ type: 'room.resync', roomId });
    } catch (error) {
      this.events.onError?.(errorMessage(error));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.teardown();
  }

  private teardown(): void {
    if (this.driftTimer) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
    this.clearGiveUp();
    if (this.membersRefreshTimer) {
      clearTimeout(this.membersRefreshTimer);
      this.membersRefreshTimer = null;
    }
    this.unsubscribeEngine?.();
    this.unsubscribeEngine = null;
    this.socket?.dispose();
    this.socket = null;
    // Leaving room mode pauses shared playback and hands the engine back.
    // The queue stays so the user can keep listening locally.
    try {
      this.engine.pause();
    } catch {
      // Engine teardown races are non-fatal here.
    }
    this.engine.setRepeatMode(this.savedRepeatMode);
    this.engine.setForceOnline(false);
    this.room = null;
    this.members = [];
    this.lastRevision = -1;
    this.lastAppliedTrackId = null;
    this.endPauseSent = false;
    this.events.onRoomChange?.(null);
    this.events.onMembersChange?.([]);
  }

  // -- host commands ------------------------------------------------------------

  private sendCommand(
    command: 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'queue',
    extra?: { positionMs?: number; trackIds?: string[]; queueIndex?: number },
  ): void {
    const roomId = this.room?.roomId;
    if (!roomId || !this.isHost || this.status !== 'live') return;
    this.socket?.send({
      type: 'room.command',
      roomId,
      command,
      expectedRevision: this.lastRevision,
      ...extra,
    });
  }

  /** Host: resume at the room's current position. */
  hostPlay(): void {
    this.sendCommand('play');
  }

  /** Host: pause for everyone. */
  hostPause(): void {
    this.sendCommand('pause');
  }

  /** Host: seek everyone to a position. */
  hostSeek(positionMs: number): void {
    this.sendCommand('seek', { positionMs: Math.max(0, Math.round(positionMs)) });
  }

  /** Host: advance to the next queue track. */
  hostNext(): void {
    this.sendCommand('next');
  }

  /** Host: go back to the previous queue track. */
  hostPrevious(): void {
    this.sendCommand('previous');
  }

  /** Host: replace the whole queue. */
  hostReplaceQueue(trackIds: string[], queueIndex = 0): void {
    this.sendCommand('queue', { trackIds, queueIndex });
  }

  // -- inbound state --------------------------------------------------------------

  private onSocketMessage(message: RoomServerMessage): void {
    const roomId = this.room?.roomId;
    if (message.type === 'pong') {
      const serverMs = Date.parse(message.serverTime);
      if (Number.isFinite(serverMs)) {
        // Feed the drift corrector's estimator (the socket keeps its own
        // copy for the same samples).
        this.clock.addSample(message.clientTime, serverMs, this.now());
      }
      return;
    }
    if (message.type === 'room.state') {
      if (roomId && message.roomId !== roomId) return;
      this.applyWireState(message.state);
      return;
    }
    if (message.type === 'room.event') {
      if (roomId && message.roomId !== roomId) return;
      if (message.event === 'room_ended') {
        this.handleRoomEnded();
      } else if (message.event === 'member_joined' || message.event === 'member_left') {
        this.scheduleMembersRefresh();
      }
      return;
    }
    if (message.type === 'error') {
      if (message.code === 'stale_revision' && typeof message.currentRevision === 'number') {
        // The gateway follows with the authoritative state; fast-forward
        // so a retried command uses the right base.
        this.lastRevision = Math.max(this.lastRevision, message.currentRevision);
      } else if (message.code === 'room_not_found' || message.code === 'room_gone') {
        void this.leaveDueToError(
          message.code === 'room_gone' ? 'This room has ended.' : 'This room no longer exists.',
        );
      } else {
        this.events.onError?.(message.message || 'Room error.');
      }
    }
  }

  /**
   * Apply authoritative state to the engine. Idempotent: stale and
   * duplicate revisions are ignored, and same-track updates only move
   * the engine when it actually diverged.
   */
  private applyWireState(wire: RoomWireState): void {
    if (this.disposed) return;
    if (wire.status === 'ENDED') {
      this.handleRoomEnded();
      return;
    }
    if (wire.revision <= this.lastRevision) return; // stale or duplicate
    this.lastRevision = wire.revision;
    const state = wireToState(wire);
    this.room = state;
    this.lastStateAt = this.now();

    const snapshot = this.engine.getSnapshot();
    const expected = this.expectedPosition(state);
    const trackChanged = state.currentTrackId !== this.lastAppliedTrackId;

    if (trackChanged) {
      // Update BEFORE the engine call: the snapshot observer fires
      // synchronously inside setQueue and must see the ids match.
      this.lastAppliedTrackId = state.currentTrackId;
      this.endPauseSent = false;
      const tracks = state.queue.map(toQueueTrack);
      void (async () => {
        try {
          await this.engine.setQueue(tracks, Math.max(0, state.queueIndex));
          await this.engine.seekTo(expected);
          if (state.playbackState === 'PAUSED') {
            this.engine.pause();
          }
        } catch {
          // Engine errors surface through its own snapshot (error state).
        }
      })();
    } else {
      const engineState = snapshot.state;
      const playing = engineState === 'playing' || engineState === 'buffering';
      const pausedish = engineState === 'paused' || engineState === 'loading';
      if (state.playbackState === 'PLAYING' && pausedish) {
        this.engine.play();
      } else if (state.playbackState === 'PAUSED' && playing) {
        this.engine.pause();
      }
      if (Math.abs(snapshot.positionMs - expected) > APPLY_SEEK_MS) {
        void this.engine.seekTo(expected).catch(() => undefined);
      }
    }
    this.events.onRoomChange?.(state);
  }

  /** Where the room should be *now*, extrapolating from serverTime. */
  private expectedPosition(state: RoomState): number {
    if (state.playbackState !== 'PLAYING') {
      return Math.max(0, state.positionMs);
    }
    const serverNow = this.now() + (this.clock.offsetMs ?? 0);
    const elapsed = serverNow - Date.parse(state.serverTime);
    return Math.max(0, state.positionMs + Math.max(0, elapsed));
  }

  // -- engine observation (host natural advance) ------------------------------------

  private onEngineSnapshot(): void {
    if (this.disposed || !this.room || this.status !== 'live') return;
    const snapshot = this.engine.getSnapshot();
    const engineTrackId = snapshot.track?.trackId ?? null;

    if (!this.isHost) return;

    // Natural track completion: the engine auto-advanced exactly one step
    // past the track we drove it to. Tell the room to follow.
    if (engineTrackId !== this.lastAppliedTrackId && engineTrackId !== null) {
      const queue = this.room.queue;
      const prevIndex = queue.findIndex((t) => t.id === this.lastAppliedTrackId);
      if (prevIndex >= 0 && queue[prevIndex + 1]?.id === engineTrackId) {
        this.sendCommand('next');
        return;
      }
      // Anything else (a local drive we didn't cause) is left alone; the
      // drift corrector pulls the engine back to the room.
    }

    // Natural queue end: the room is still PLAYING but the engine ran out
    // of tracks. Pause the room honestly at the end instead of letting the
    // position run past the duration.
    if (snapshot.state === 'ended' && this.room.playbackState === 'PLAYING' && !this.endPauseSent) {
      this.endPauseSent = true;
      this.sendCommand('pause');
    }
  }

  // -- drift correction -----------------------------------------------------------------

  private driftTick(): void {
    if (this.disposed || !this.room || this.status !== 'live') return;
    if (this.room.playbackState !== 'PLAYING') return;
    const snapshot = this.engine.getSnapshot();
    const expected = this.expectedPosition(this.room);

    if (snapshot.state === 'playing') {
      if (Math.abs(snapshot.positionMs - expected) > DRIFT_CORRECT_MS) {
        void this.engine.seekTo(expected).catch(() => undefined);
      }
      return;
    }
    if (snapshot.state === 'paused') {
      // Only pull the engine back right after a room state was applied:
      // a pause that close to an apply is our own pipeline (setQueue →
      // seek → play) glitching, not the user. A pause the user made
      // deliberately (or the OS made for us) stays paused; the room
      // screen offers a manual resync.
      if (this.now() - this.lastStateAt < RESUME_WINDOW_MS) {
        this.engine.play();
        if (Math.abs(snapshot.positionMs - expected) > DRIFT_CORRECT_MS) {
          void this.engine.seekTo(expected).catch(() => undefined);
        }
      }
    }
  }

  // -- room end / errors --------------------------------------------------------------------

  private handleRoomEnded(): void {
    if (this.status === 'ended' || this.status === 'idle') return;
    try {
      this.engine.pause();
    } catch {
      // Non-fatal.
    }
    if (this.room) {
      this.room = { ...this.room, status: 'ENDED' };
      this.events.onRoomChange?.(this.room);
    }
    this.socket?.disconnect();
    this.setStatus('ended');
  }

  private async leaveDueToError(message: string): Promise<void> {
    this.events.onError?.(message);
    await this.leave();
    this.setStatus('error');
  }

  private armGiveUp(): void {
    this.clearGiveUp();
    this.giveUpTimer = setTimeout(() => {
      this.giveUpTimer = null;
      if (this.status === 'reconnecting' || this.status === 'connecting') {
        void this.leaveDueToError('Connection lost. You left the room.');
      }
    }, RECONNECT_GIVE_UP_MS);
  }

  private clearGiveUp(): void {
    if (this.giveUpTimer) {
      clearTimeout(this.giveUpTimer);
      this.giveUpTimer = null;
    }
  }

  private scheduleMembersRefresh(): void {
    if (this.membersRefreshTimer) return;
    this.membersRefreshTimer = setTimeout(() => {
      this.membersRefreshTimer = null;
      this.refreshMembers().catch(() => undefined);
    }, 500);
  }

  private async refreshMembers(): Promise<void> {
    const roomId = this.room?.roomId;
    if (!roomId) return;
    const members = await listRoomMembers(this.api, roomId);
    this.members = members;
    this.events.onMembersChange?.(members.slice());
  }

  private setStatus(status: RoomConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatusChange?.(status);
  }
}

/** Convert an HTTP RoomState back to the wire shape the applier expects. */
function wireFromState(state: RoomState): RoomWireState {
  return {
    roomId: state.roomId,
    revision: state.revision,
    status: state.status,
    playbackState: state.playbackState,
    currentTrackId: state.currentTrackId,
    currentTrack: state.currentTrack,
    queueIndex: state.queueIndex,
    queue: state.queue,
    positionMs: state.positionMs,
    serverTime: state.serverTime,
    role: state.role,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}
