// Phase 8 — public surface of the playback engine.
//
// Layers:
// - types.ts: UI-agnostic contracts (PlaybackState, QueueTrack,
//   EngineSnapshot, AudioDriver).
// - PlaybackEngine.ts: framework-free queue/session/player coordinator.
// - expoAudioDriver.ts: the only adapter that touches expo-audio.
// - provider.tsx: thin React binding (no player UI).

export { PlaybackEngine, HEARTBEAT_INTERVAL_MS } from './PlaybackEngine';
export type { PlaybackEngineOptions } from './PlaybackEngine';
export { createExpoAudioDriver } from './expoAudioDriver';
export { PlaybackProvider, usePlayback } from './provider';
export type { PlaybackContextValue } from './provider';
export { toQueueTrack } from './types';
export type {
  AudioDriver,
  DriverStatus,
  EngineListener,
  EngineSnapshot,
  PlaybackState,
  QueueTrack,
} from './types';
