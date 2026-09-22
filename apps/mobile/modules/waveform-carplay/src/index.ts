// Phase 23 — typed JS interface for the WaveformCarplay native module.
//
// This file is the module's public contract. The native side (Swift,
// iOS only) implements it; the app's CarPlay controller
// (apps/mobile/src/carplay/) is the only consumer. Everything crosses
// the bridge as plain JSON — no UIKit/CarPlay types leak into JS.
//
// Native -> JS events: onCarPlayConnect, onCarPlayDisconnect,
//   onBrowseRequest, onPlayRequest, onCommand.
// JS -> native functions: isCarPlayConnected, notifyAuthState, setTabs,
//   resolveBrowse, resolvePlay, updatePlayingItem, showAlert.

import { NativeModule, requireNativeModule } from 'expo-modules-core';

/** Playback/mode commands the native side can raise. */
export type CarPlayCommandName =
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'shuffle'
  | 'repeat';

export type CarPlayItemKind = 'container' | 'track' | 'action' | 'message';

/** One row in a CarPlay list, as plain JSON. */
export interface CarPlayItemPayload {
  /** Stable id, e.g. "track:<trackId>", "node:liked", "action:shuffle". */
  id: string;
  kind: CarPlayItemKind;
  title: string;
  subtitle?: string;
  /**
   * For kind=container: the node id to browse on selection.
   * For kind=track: the node id that provides the queue context.
   * For kind=action: the command name (see CarPlayCommandName).
   */
  target?: string;
}

export interface CarPlaySectionPayload {
  /** Optional section header; omitted for a single flat list. */
  title?: string;
  items: CarPlayItemPayload[];
}

export interface CarPlayTabPayload {
  /** Node id browsed for this tab's content (also its queue context). */
  nodeId: string;
  title: string;
  sections: CarPlaySectionPayload[];
}

export interface CarPlayBrowseOk {
  ok: true;
  /** Title for the pushed list template. */
  title: string;
  sections: CarPlaySectionPayload[];
}

export interface CarPlayBrowseError {
  ok: false;
  title: string;
  message: string;
}

export type CarPlayBrowseResult = CarPlayBrowseOk | CarPlayBrowseError;

export interface CarPlayPlayOk {
  ok: true;
}

export interface CarPlayPlayError {
  ok: false;
  title: string;
  message: string;
}

export type CarPlayPlayResult = CarPlayPlayOk | CarPlayPlayError;

export interface CarPlayBrowseRequestEvent {
  requestId: string;
  nodeId: string;
}

export interface CarPlayPlayRequestEvent {
  requestId: string;
  /** Item id, e.g. "track:<trackId>". */
  itemId: string;
  /** Node id that provides the queue context. */
  nodeId: string;
}

export interface CarPlayCommandEvent {
  command: CarPlayCommandName;
}

export type CarPlayNativeEventMap = {
  onCarPlayConnect: () => void;
  onCarPlayDisconnect: () => void;
  onBrowseRequest: (event: CarPlayBrowseRequestEvent) => void;
  onPlayRequest: (event: CarPlayPlayRequestEvent) => void;
  onCommand: (event: CarPlayCommandEvent) => void;
};

declare class WaveformCarplayModule extends NativeModule<CarPlayNativeEventMap> {
  /** True while a CarPlay scene is connected. Safe to call any time. */
  isCarPlayConnected(): boolean;
  /** Tell native whether the JS side currently has a signed-in session. */
  notifyAuthState(signedIn: boolean): void;
  /** Replace the CarPlay tab-bar root with fully populated tabs. */
  setTabs(tabs: CarPlayTabPayload[]): void;
  /** Answer a pending onBrowseRequest. */
  resolveBrowse(requestId: string, result: CarPlayBrowseResult): void;
  /** Answer a pending onPlayRequest. */
  resolvePlay(requestId: string, result: CarPlayPlayResult): void;
  /** Highlight the now-playing track item (by item id) across templates. */
  updatePlayingItem(itemId: string | null): void;
  /** Present a modal CarPlay alert (sign-in, errors). */
  showAlert(title: string, message: string): void;
}

const WaveformCarplay = requireNativeModule<WaveformCarplayModule>('WaveformCarplay');

export default WaveformCarplay;
