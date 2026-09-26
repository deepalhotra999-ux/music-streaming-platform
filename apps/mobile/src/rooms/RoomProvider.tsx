// Phase 28 — React binding for synchronized listening rooms.
//
// Owns one RoomSession for the app lifetime (per sign-in). The session
// drives the shared PlaybackEngine from server-authoritative room state;
// this provider only subscribes components to session status/room/members
// and forwards host commands. Mounted inside PlaybackProvider so the
// engine is always available; torn down on sign-out.

import NetInfo from '@react-native-community/netinfo';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  getApiBaseUrl,
  type ApiClient,
  type CreateRoomInput,
  type CreateRoomInvitationResult,
  type RoomInvitation,
  type RoomMember,
  type RoomState,
} from '../api';
import { createRoomInvitation, listRoomInvitations, revokeRoomInvitation } from '../api';
import { getActiveEngine, subscribeEngine } from '../playback/engineRegistry';
import type { PlaybackEngine } from '../playback/PlaybackEngine';
import { RoomSession, type RoomConnectionStatus } from './controller';

export interface RoomContextValue {
  /** Session lifecycle: idle → joining → connecting → live ⇄ reconnecting → ended/error. */
  status: RoomConnectionStatus;
  /** Authoritative room state, null when not in a room. */
  room: RoomState | null;
  members: RoomMember[];
  isHost: boolean;
  /** Last async error (join failures, socket errors). Cleared on change. */
  error: string | null;
  clearError: () => void;
  /** Create a room as host and attach. Throws on failure. */
  joinAsHost: (input: CreateRoomInput) => Promise<void>;
  /** Join via invitation token and attach. Throws on failure. */
  joinWithToken: (roomId: string, token: string) => Promise<void>;
  /** Leave the room and restore local playback control. */
  leave: () => Promise<void>;
  /** Host only: terminate the room for everyone. */
  endRoom: () => Promise<void>;
  /** Re-fetch authoritative state and re-apply it to the engine. */
  resync: () => Promise<void>;
  // -- host transport (no-ops when not the host or not live) --
  hostPlay: () => void;
  hostPause: () => void;
  hostSeek: (positionMs: number) => void;
  hostNext: () => void;
  hostPrevious: () => void;
  hostReplaceQueue: (trackIds: string[], queueIndex?: number) => void;
  // -- invitations (host only; thin wrappers over the API client) --
  createInvitation: () => Promise<CreateRoomInvitationResult>;
  listInvitations: () => Promise<RoomInvitation[]>;
  revokeInvitation: (invitationId: string) => Promise<void>;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext);
  if (!value) {
    throw new Error('useRoom must be used within RoomProvider');
  }
  return value;
}

interface RoomProviderProps {
  children: ReactNode;
  /** Authenticated client from useAuth(). */
  api: ApiClient;
  /** Reads the current access token for the WS query auth. */
  getAccessToken: () => string | null;
  /** Injected for tests; defaults to getApiBaseUrl(). */
  baseUrl?: string;
}

export function RoomProvider({ children, api, getAccessToken, baseUrl }: RoomProviderProps) {
  const [engine, setEngine] = useState<PlaybackEngine | null>(() => getActiveEngine());
  const [status, setStatus] = useState<RoomConnectionStatus>('idle');
  const [room, setRoom] = useState<RoomState | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const tokenRef = useRef(getAccessToken);
  tokenRef.current = getAccessToken;

  useEffect(() => subscribeEngine(setEngine), []);

  useEffect(() => {
    if (!engine) return;
    const session = new RoomSession(
      {
        api,
        engine,
        baseUrl: baseUrl ?? getApiBaseUrl(),
        getAccessToken: () => tokenRef.current(),
      },
      {
        onStatusChange: (next) => {
          setStatus(next);
          if (next !== 'error') setError(null);
        },
        onRoomChange: setRoom,
        onMembersChange: setMembers,
        onError: setError,
      },
    );
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
  }, [engine, api, baseUrl]);

  // Social listening requires connectivity: a dropped network fast-tracks
  // the session's reconnect give-up instead of silently drifting.
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const online = state.isConnected === true && state.isInternetReachable !== false;
      if (!online) {
        sessionRef.current?.notifyNetworkLost();
      }
    });
    return unsubscribe;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<RoomContextValue>(
    () => ({
      status,
      room,
      members,
      isHost: room?.role === 'HOST',
      error,
      clearError,
      joinAsHost: async (input: CreateRoomInput) => {
        setError(null);
        await sessionRef.current?.joinAsHost(input);
      },
      joinWithToken: async (roomId: string, token: string) => {
        setError(null);
        await sessionRef.current?.joinWithToken(roomId.trim(), token.trim());
      },
      leave: async () => {
        await sessionRef.current?.leave();
      },
      endRoom: async () => {
        await sessionRef.current?.endRoom();
      },
      resync: async () => {
        await sessionRef.current?.resync();
      },
      hostPlay: () => sessionRef.current?.hostPlay(),
      hostPause: () => sessionRef.current?.hostPause(),
      hostSeek: (positionMs: number) => sessionRef.current?.hostSeek(positionMs),
      hostNext: () => sessionRef.current?.hostNext(),
      hostPrevious: () => sessionRef.current?.hostPrevious(),
      hostReplaceQueue: (trackIds: string[], queueIndex = 0) =>
        sessionRef.current?.hostReplaceQueue(trackIds, queueIndex),
      createInvitation: async () => {
        const roomId = sessionRef.current?.roomId;
        if (!roomId) throw new Error('Not in a room.');
        return createRoomInvitation(api, roomId);
      },
      listInvitations: async () => {
        const roomId = sessionRef.current?.roomId;
        if (!roomId) throw new Error('Not in a room.');
        return listRoomInvitations(api, roomId);
      },
      revokeInvitation: async (invitationId: string) => {
        const roomId = sessionRef.current?.roomId;
        if (!roomId) throw new Error('Not in a room.');
        return revokeRoomInvitation(api, roomId, invitationId);
      },
    }),
    [status, room, members, error, clearError, api],
  );

  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}
