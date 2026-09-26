// Phase 28 — in-memory room hub: tracks which WebSocket connections are
// subscribed to which rooms and broadcasts state to room members.
//
// Single-instance limitation: this hub lives in process memory. A
// multi-instance deployment would need a shared pub/sub (e.g. Redis) so a
// state change applied on one instance reaches sockets on another. The
// revision protocol itself is instance-independent (the database is the
// source of truth), so this only affects broadcast fan-out, not
// correctness of the authoritative state.

import type { WebSocket } from 'ws';

/** Per-connection state, keyed off the raw socket. */
export interface RoomClient {
  userId: string;
  /** Rooms this socket has joined (and been authorized for). */
  rooms: Set<string>;
  /** Sliding window of command timestamps (ms) for per-socket throttling. */
  commandTimestamps: number[];
}

const clients = new WeakMap<WebSocket, RoomClient>();
const rooms = new Map<string, Set<WebSocket>>();

export function registerClient(socket: WebSocket, userId: string): RoomClient {
  const client: RoomClient = { userId, rooms: new Set(), commandTimestamps: [] };
  clients.set(socket, client);
  return client;
}

export function getClient(socket: WebSocket): RoomClient | undefined {
  return clients.get(socket);
}

export function joinRoomChannel(roomId: string, socket: WebSocket): void {
  const client = clients.get(socket);
  if (!client) return;
  let set = rooms.get(roomId);
  if (!set) {
    set = new Set();
    rooms.set(roomId, set);
  }
  set.add(socket);
  client.rooms.add(roomId);
}

export function leaveRoomChannel(roomId: string, socket: WebSocket): void {
  const client = clients.get(socket);
  const set = rooms.get(roomId);
  if (set) {
    set.delete(socket);
    if (set.size === 0) {
      rooms.delete(roomId);
    }
  }
  client?.rooms.delete(roomId);
}

/** Remove the socket from every room it joined (on disconnect). */
export function leaveAllRooms(socket: WebSocket): void {
  const client = clients.get(socket);
  if (!client) return;
  for (const roomId of [...client.rooms]) {
    leaveRoomChannel(roomId, socket);
  }
  clients.delete(socket);
}

/** Send a JSON message to every open socket subscribed to the room. */
export function broadcastToRoom(roomId: string, message: unknown): void {
  const set = rooms.get(roomId);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const socket of set) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}

/** Number of sockets currently subscribed to a room (observability). */
export function roomSubscriberCount(roomId: string): number {
  return rooms.get(roomId)?.size ?? 0;
}

/**
 * Drop every socket belonging to a user from a room channel. Used when a
 * participant leaves over HTTP: their sockets must stop receiving room
 * broadcasts immediately, since the membership that authorized them is
 * gone. The sockets themselves stay open (they may serve other rooms).
 */
export function evictUserFromRoom(roomId: string, userId: string): void {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const socket of [...set]) {
    if (clients.get(socket)?.userId === userId) {
      leaveRoomChannel(roomId, socket);
    }
  }
}

/** Drop every socket from a room channel (e.g. after the room ends). */
export function evictAllFromRoom(roomId: string): void {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const socket of [...set]) {
    leaveRoomChannel(roomId, socket);
  }
}

/** Test-only: reset hub state between tests in the same process. */
export function resetHubForTests(): void {
  rooms.clear();
}
