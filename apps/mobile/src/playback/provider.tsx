// Phase 8 — React binding for the playback engine.
//
// Thin by design: the engine owns all playback logic and state; this only
// subscribes components to its snapshots via useSyncExternalStore and
// forwards control calls. No player UI lives here (that is a later phase).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import { getApiBaseUrl, type ApiClient } from '../api';
import { PlaybackEngine } from './PlaybackEngine';
import { createExpoAudioDriver } from './expoAudioDriver';
import { setActiveEngine } from './engineRegistry';
import type { EngineSnapshot, QueueTrack, RepeatMode } from './types';

export interface PlaybackContextValue extends EngineSnapshot {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seekTo: (positionMs: number) => Promise<void>;
  next: () => void;
  previous: () => void;
  stop: () => void;
  retry: () => Promise<void>;
  setQueue: (tracks: QueueTrack[], startIndex?: number) => Promise<void>;
  enqueue: (track: QueueTrack) => void;
  clearQueue: () => void;
  /** Phase 9 — queue management and playback modes for the player UI. */
  removeAt: (index: number) => void;
  playAt: (index: number) => void;
  setRepeatMode: (mode: RepeatMode) => void;
  setShuffle: (enabled: boolean) => void;
}

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

export function usePlayback(): PlaybackContextValue {
  const value = useContext(PlaybackContext);
  if (!value) {
    throw new Error('usePlayback must be used within PlaybackProvider');
  }
  return value;
}

interface PlaybackProviderProps {
  children: ReactNode;
  /** Authenticated client from useAuth(). */
  api: ApiClient;
  /** Injected for tests; defaults to getApiBaseUrl(). */
  baseUrl?: string;
}

export function PlaybackProvider({ children, api, baseUrl }: PlaybackProviderProps) {
  const engineRef = useRef<PlaybackEngine | null>(null);
  if (engineRef.current === null) {
    // Singleton for the app lifetime: the engine survives navigation and
    // remounts, which is what lets a future background service reuse it.
    engineRef.current = new PlaybackEngine({
      api,
      baseUrl: baseUrl ?? getApiBaseUrl(),
      driver: createExpoAudioDriver(),
    });
  }
  const engine = engineRef.current;

  useEffect(() => {
    // Native audio-mode setup; failures are non-fatal here (the engine
    // surfaces playback errors itself).
    engine.initialize().catch(() => undefined);
    // Phase 23 — register the single engine instance so CarPlay drives
    // this exact engine (no second player/queue/session flow).
    setActiveEngine(engine);
    // On unmount (e.g. sign-out) stop playback and release the player and
    // any pending loads, so audio never keeps playing for a signed-out
    // user. The engine instance is discarded with the provider, so a full
    // stop (not destroy) keeps strict-mode remounts safe.
    return () => {
      setActiveEngine(null);
      engine.stop();
    };
  }, [engine]);

  const snapshot = useSyncExternalStore(
    useCallback((onChange) => engine.subscribe(onChange), [engine]),
    useCallback(() => engine.getSnapshot(), [engine]),
  );

  const value = useMemo<PlaybackContextValue>(
    () => ({
      ...snapshot,
      play: () => engine.play(),
      pause: () => engine.pause(),
      toggle: () => engine.toggle(),
      seekTo: (positionMs: number) => engine.seekTo(positionMs),
      next: () => engine.next(),
      previous: () => engine.previous(),
      stop: () => engine.stop(),
      retry: () => engine.retry(),
      setQueue: (tracks: QueueTrack[], startIndex?: number) => engine.setQueue(tracks, startIndex),
      enqueue: (track: QueueTrack) => engine.enqueue(track),
      clearQueue: () => engine.clearQueue(),
      removeAt: (index: number) => engine.removeAt(index),
      playAt: (index: number) => engine.playAt(index),
      setRepeatMode: (mode: RepeatMode) => engine.setRepeatMode(mode),
      setShuffle: (enabled: boolean) => engine.setShuffle(enabled),
    }),
    [engine, snapshot],
  );

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}
