// Phase 28 — synchronized listening rooms public surface.

export { RoomSocket, ClockSync, wsBaseUrl } from './transport';
export type {
  RoomClientMessage,
  RoomServerMessage,
  RoomSocketEvents,
  RoomSocketOptions,
  RoomWireState,
  RoomWireTrack,
  SocketConnectionState,
  WebSocketFactory,
  WebSocketLike,
} from './transport';
export {
  RoomSession,
  DRIFT_CORRECT_MS,
  APPLY_SEEK_MS,
  DRIFT_TICK_MS,
  RESUME_WINDOW_MS,
  RECONNECT_GIVE_UP_MS,
} from './controller';
export type { RoomConnectionStatus, RoomSessionEvents, RoomSessionOptions } from './controller';
export { RoomProvider, useRoom } from './RoomProvider';
export type { RoomContextValue } from './RoomProvider';
export { parseInviteText } from './invite';
