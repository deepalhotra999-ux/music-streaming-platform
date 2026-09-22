// Phase 23 — registry for the single shared PlaybackEngine instance.
//
// The engine is still created and owned by PlaybackProvider exactly as
// before. This registry is a narrow, read-only seam so CarPlay (and only
// CarPlay) can reach the *same* engine instead of building a second
// player, queue, or session flow. PlaybackProvider sets the engine on
// mount and clears it on cleanup; everything else only reads.

import type { PlaybackEngine } from './PlaybackEngine';

let activeEngine: PlaybackEngine | null = null;

type EngineListener = (engine: PlaybackEngine | null) => void;
const listeners = new Set<EngineListener>();

/** Called only by PlaybackProvider. */
export function setActiveEngine(engine: PlaybackEngine | null): void {
  activeEngine = engine;
  for (const listener of listeners) {
    try {
      listener(engine);
    } catch {
      // A failing listener must not break engine registration.
    }
  }
}

/** Returns the current engine, or null when signed out. */
export function getActiveEngine(): PlaybackEngine | null {
  return activeEngine;
}

/**
 * Subscribe to engine availability. The listener fires immediately on
 * registration/clear, not on every snapshot — CarPlay uses it to pick up
 * the now-playing subscription when PlaybackProvider mounts after the
 * CarPlay host has already attached (cold start in the car).
 */
export function subscribeEngine(listener: EngineListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
