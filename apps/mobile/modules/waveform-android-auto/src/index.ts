// Phase 24 — typed JS interface for the WaveformAndroidAuto native module.
//
// This file is the module's public contract. The native side (Kotlin,
// Android only) implements it; the app's Android Auto controller
// (apps/mobile/src/androidauto/) is the only consumer. Everything crosses
// the bridge as plain JSON — no Media3 types leak into JS.
//
// Native -> JS events: onLibraryRootRequest, onChildrenRequest,
//   onItemRequest, onPlayRequest, onCommand, onSearchRequest.
// JS -> native functions: isServiceAvailable, notifyAuthState,
//   resolveLibraryRoot, resolveChildren, resolveItem, resolvePlay,
//   resolveSearch, updatePlaybackState, updateQueue, updateRepeatShuffle.

import { NativeModule, requireNativeModule } from 'expo-modules-core';

/** Transport/queue commands the native side can raise. */
export type AndroidAutoCommandName =
  | 'play'
  | 'pause'
  | 'stop'
  | 'prepare'
  | 'next'
  | 'previous'
  | 'restart'
  | 'seek'
  | 'set-item'
  | 'shuffle'
  | 'repeat'
  | 'queue-add'
  | 'queue-move'
  | 'queue-replace'
  | 'queue-remove'
  | 'play-ids';

/** One browsable/playable entry in the Media3 library tree, as plain JSON. */
export interface AutoMediaItemPayload {
  /** Stable media id, e.g. "waveform:track:<trackId>", "waveform:album:<id>". */
  mediaId: string;
  title: string;
  subtitle?: string;
  browsable: boolean;
  playable: boolean;
  durationMs?: number;
  artworkUrl?: string | null;
}

export interface AutoChildrenResult {
  ok: boolean;
  items: AutoMediaItemPayload[];
}

export interface AutoPlayOk {
  ok: true;
}

export interface AutoPlayError {
  ok: false;
  title: string;
  message: string;
}

export type AutoPlayResult = AutoPlayOk | AutoPlayError;

/** Engine playback state projected onto the native virtual player. */
export type AutoEngineState =
  'idle' | 'loading' | 'buffering' | 'playing' | 'paused' | 'error' | 'ended';

export interface AutoPlaybackStatePayload {
  state: AutoEngineState;
  positionMs: number;
  durationMs: number;
  /** Human-safe error text; shown by the car host when state is 'error'. */
  error?: string | null;
  /** True when the last session creation was denied for subscription. */
  locked?: boolean;
}

export type AutoRepeatMode = 'off' | 'all' | 'one';

export interface AutoLibraryRootRequestEvent {
  requestId: string;
}

export interface AutoChildrenRequestEvent {
  requestId: string;
  parentId: string;
  page: number;
  pageSize: number;
}

export interface AutoItemRequestEvent {
  requestId: string;
  mediaId: string;
}

export interface AutoPlayRequestEvent {
  requestId: string;
  /** Media id of the tapped item, e.g. "waveform:track:<trackId>". */
  mediaId?: string;
  /** Media ids when the car host set a list through the session path. */
  mediaIds?: string[];
  startIndex?: number;
}

export interface AutoCommandEvent {
  command: AndroidAutoCommandName;
  /** Present for command === 'seek'. */
  positionMs?: number;
  /** Present for command === 'set-item'. Engine queue index. */
  index?: number;
  /** Present for command === 'shuffle'. */
  shuffle?: boolean;
  /** Present for command === 'repeat'. Media3 repeat mode int. */
  repeatMode?: number;
  /** Present for queue commands. */
  mediaIds?: string[];
}

export interface AutoSearchRequestEvent {
  requestId: string;
  query: string;
}

export type AndroidAutoNativeEventMap = {
  onLibraryRootRequest: (event: AutoLibraryRootRequestEvent) => void;
  onChildrenRequest: (event: AutoChildrenRequestEvent) => void;
  onItemRequest: (event: AutoItemRequestEvent) => void;
  onPlayRequest: (event: AutoPlayRequestEvent) => void;
  onCommand: (event: AutoCommandEvent) => void;
  onSearchRequest: (event: AutoSearchRequestEvent) => void;
};

declare class WaveformAndroidAutoModule extends NativeModule<AndroidAutoNativeEventMap> {
  /** True once the MediaLibraryService has been created. Safe any time. */
  isServiceAvailable(): boolean;
  /** Tell native whether the JS side currently has a signed-in session. */
  notifyAuthState(signedIn: boolean): void;
  /** Answer a pending onLibraryRootRequest with the root media id. */
  resolveLibraryRoot(requestId: string, rootId: string): void;
  /** Answer a pending onChildrenRequest. ok=false surfaces a car-side error. */
  resolveChildren(requestId: string, result: AutoChildrenResult): void;
  /** Answer a pending onItemRequest; null when the id is unknown. */
  resolveItem(requestId: string, item: AutoMediaItemPayload | null): void;
  /** Answer a pending onPlayRequest. */
  resolvePlay(requestId: string, result: AutoPlayResult): void;
  /** Answer a pending onSearchRequest. */
  resolveSearch(requestId: string, items: AutoMediaItemPayload[]): void;
  /** Project engine playback state/position onto the virtual player. */
  updatePlaybackState(state: AutoPlaybackStatePayload): void;
  /** Project the engine queue onto the virtual player. */
  updateQueue(items: AutoMediaItemPayload[], activeIndex: number): void;
  /** Project shuffle/repeat modes onto the virtual player. */
  updateRepeatShuffle(repeatMode: AutoRepeatMode, shuffle: boolean): void;
}

const WaveformAndroidAuto = requireNativeModule<WaveformAndroidAutoModule>('WaveformAndroidAuto');

export default WaveformAndroidAuto;
