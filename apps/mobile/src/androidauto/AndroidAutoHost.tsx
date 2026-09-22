// Phase 24 — mounts the Android Auto controller inside the authenticated
// playback shell. Renders nothing: the native media service owns the car
// UI; this host only wires native events to the shared PlaybackEngine.
//
// Lifecycle: PlaybackProvider is mounted only while signed in (it
// unmounts on sign-out), so mounting here gives us attach-on-sign-in and
// detach-on-sign-out for free — including notifyAuthState(false), which
// makes the native service clear the car UI back to its safe sign-in gate.

import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { getActiveEngine } from '../playback/engineRegistry';
import { AndroidAutoController } from './controller';

export function AndroidAutoHost() {
  const { api } = useAuth();
  const controllerRef = useRef<AndroidAutoController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new AndroidAutoController({
      api,
      getEngine: getActiveEngine,
    });
  }

  useEffect(() => {
    const controller = controllerRef.current;
    controller?.attach();
    return () => {
      controller?.detach();
    };
  }, []);

  return null;
}
