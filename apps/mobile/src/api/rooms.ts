// Phase 28 — synchronized listening room endpoints against the Phase 28 API.
//
// All identity is server-derived from the Bearer token. Rooms are
// private and invite-only: there is no listing/discovery endpoint, and
// room state carries track IDs plus display metadata only — never
// playback sessions, tokens, or audio URLs.

import type { ApiClient } from './client';

/** Membership role inside a room. The host owns all playback control. */
export type RoomRole = 'HOST' | 'PARTICIPANT';

/** Room lifecycle. Membership rows survive END; the state is terminal. */
export type RoomStatus = 'ACTIVE' | 'ENDED';

/** Server-authoritative transport state of the room. */
export type RoomPlaybackState = 'PLAYING' | 'PAUSED';

/** One track in the room queue snapshot. */
export interface RoomTrack {
  id: string;
  title: string;
  artistName: string;
  durationMs: number;
  artworkUrl: string | null;
}

/**
 * Authoritative room state.
 *
 * `positionMs` is valid at `serverTime`: clients extrapolate with their
 * estimated server-clock offset while PLAYING. `revision` is monotonic;
 * host commands carry `expectedRevision` for compare-and-swap.
 */
export interface RoomState {
  roomId: string;
  revision: number;
  status: RoomStatus;
  playbackState: RoomPlaybackState;
  currentTrackId: string | null;
  currentTrack: RoomTrack | null;
  queueIndex: number;
  queue: RoomTrack[];
  positionMs: number;
  /** ISO-8601 server timestamp the position is valid at. */
  serverTime: string;
  /** The caller's own role in this room. */
  role: RoomRole;
}

/** A room member for the participant list. */
export interface RoomMember {
  userId: string;
  displayName: string;
  role: RoomRole;
  joinedAt: string;
}

/**
 * An invitation row. The raw token is returned exactly once at creation;
 * rows never contain tokens (only their SHA-256 hash server-side).
 */
export interface RoomInvitation {
  id: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

/** Creation response: the raw invitation token, issued exactly once. */
export interface CreateRoomInvitationResult extends RoomInvitation {
  token: string;
}

export interface CreateRoomInput {
  /** Seed the queue from explicit tracks. Mutually exclusive with playlistId. */
  trackIds?: string[];
  /** Seed the queue from a playlist snapshot the caller can access. */
  playlistId?: string;
}

/** Create a private room as host. Requires playback entitlement. */
export function createRoom(client: ApiClient, input: CreateRoomInput): Promise<RoomState> {
  return client.post<RoomState>('/v1/rooms', input);
}

/** Fetch authoritative state. Members only; others get an opaque 404. */
export function getRoomState(client: ApiClient, roomId: string): Promise<RoomState> {
  return client.get<RoomState>(`/v1/rooms/${roomId}`);
}

/**
 * Join via a single-use invitation token. Idempotent for current members
 * (the token is ignored then). Requires playback entitlement; joining
 * never grants any.
 */
export function joinRoom(client: ApiClient, roomId: string, token: string): Promise<RoomState> {
  return client.post<RoomState>(`/v1/rooms/${roomId}/join`, { token });
}

/** Leave the room. The host leaving ends the room for everyone. */
export function leaveRoom(client: ApiClient, roomId: string): Promise<void> {
  return client.post<void>(`/v1/rooms/${roomId}/leave`);
}

/** Host only. Terminates the room; members keep the ENDED state. */
export function endRoom(client: ApiClient, roomId: string): Promise<void> {
  return client.post<void>(`/v1/rooms/${roomId}/end`);
}

/** Members only; the host is listed first. */
export function listRoomMembers(client: ApiClient, roomId: string): Promise<RoomMember[]> {
  return client.get<RoomMember[]>(`/v1/rooms/${roomId}/members`);
}

/**
 * Host only. Returns the raw token exactly once — it is never stored
 * server-side and never appears again.
 */
export function createRoomInvitation(
  client: ApiClient,
  roomId: string,
): Promise<CreateRoomInvitationResult> {
  return client.post<CreateRoomInvitationResult>(`/v1/rooms/${roomId}/invitations`);
}

/** Host only. Invitation rows never contain tokens. */
export function listRoomInvitations(client: ApiClient, roomId: string): Promise<RoomInvitation[]> {
  return client.get<RoomInvitation[]>(`/v1/rooms/${roomId}/invitations`);
}

/** Host only. Already-used invitations cannot be revoked. Resolves on 204. */
export function revokeRoomInvitation(
  client: ApiClient,
  roomId: string,
  invitationId: string,
): Promise<void> {
  return client.delete<void>(`/v1/rooms/${roomId}/invitations/${invitationId}`);
}
