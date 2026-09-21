// Phase 8 — expo-audio adapter behind the engine's AudioDriver seam.
//
// This is the only file in src/playback that touches expo-audio. The engine
// never imports expo-audio directly, so it stays testable in plain Node and
// a future native module can replace this adapter without engine changes.

import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import type { AudioDriver, DriverStatus } from './types';

const EMPTY_STATUS: DriverStatus = {
  isLoaded: false,
  isBuffering: false,
  playing: false,
  didJustFinish: false,
  currentTimeSec: 0,
  durationSec: 0,
  error: null,
};

function mapStatus(status: AudioStatus): DriverStatus {
  return {
    isLoaded: status.isLoaded,
    isBuffering: status.isBuffering,
    playing: status.playing,
    didJustFinish: status.didJustFinish,
    currentTimeSec: status.currentTime,
    durationSec: status.duration,
    error: status.error,
  };
}

/**
 * Create the production audio driver over expo-audio (iOS AVPlayer /
 * Android ExoPlayer — both play HLS natively).
 */
export function createExpoAudioDriver(): AudioDriver {
  let player: AudioPlayer | null = null;
  let statusSubscription: { remove(): void } | null = null;
  let statusListener: ((status: DriverStatus) => void) | null = null;
  let lastStatus: DriverStatus = EMPTY_STATUS;
  let audioModeConfigured = false;

  const destroyPlayer = (): void => {
    statusSubscription?.remove();
    statusSubscription = null;
    // remove() frees the native player; the engine never holds two at once.
    player?.remove();
    player = null;
    lastStatus = EMPTY_STATUS;
  };

  const publish = (status: DriverStatus): void => {
    lastStatus = status;
    statusListener?.(status);
  };

  return {
    async initialize(): Promise<void> {
      if (audioModeConfigured) {
        return;
      }
      audioModeConfigured = true;
      await setAudioModeAsync({
        // Play through the silent switch, like every music app.
        playsInSilentMode: true,
        // Exclusive audio focus; also the mode lock-screen controls
        // require when that phase wires them up (see ADR-007).
        interruptionMode: 'doNotMix',
        // Foreground playback only in Phase 8. Background playback (audio
        // background mode, foreground service, lock-screen controls) is a
        // later phase; see ADR-007 for the seam.
        shouldPlayInBackground: false,
      });
    },

    async load(uri: string): Promise<void> {
      // Tear down first: never two native players alive at once.
      destroyPlayer();
      const next = createAudioPlayer({ uri }, { updateInterval: 500 });
      player = next;
      statusSubscription = next.addListener('playbackStatusUpdate', (status) => {
        publish(mapStatus(status));
      });
      publish(mapStatus(next.currentStatus));
    },

    play(): void {
      player?.play();
    },

    pause(): void {
      player?.pause();
    },

    async seekTo(positionMs: number): Promise<void> {
      // expo-audio seeks in seconds.
      await player?.seekTo(Math.max(0, positionMs) / 1000);
    },

    getStatus(): DriverStatus {
      return lastStatus;
    },

    onStatusChange(listener: (status: DriverStatus) => void): () => void {
      statusListener = listener;
      return () => {
        if (statusListener === listener) {
          statusListener = null;
        }
      };
    },

    destroy(): void {
      destroyPlayer();
      statusListener = null;
    },
  };
}
