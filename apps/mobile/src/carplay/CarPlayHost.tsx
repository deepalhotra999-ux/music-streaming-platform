// Phase 23 — mounts the CarPlay controller inside the authenticated
// playback shell. Renders nothing: the native side owns every CarPlay
// template; this host only wires JS events to the shared PlaybackEngine.
//
// Lifecycle: PlaybackProvider is mounted only while signed in (it
// unmounts on sign-out), so mounting here gives us attach-on-sign-in and
// detach-on-sign-out for free — including notifyAuthState(false), which
// makes native show its safe sign-in gate.

import { useEffect, useRef } from 'react';
import { useAuth } from '../auth/AuthContext';
import { getActiveEngine } from '../playback/engineRegistry';
import { CarPlayController } from './controller';

export function CarPlayHost() {
  const { api } = useAuth();
  const controllerRef = useRef<CarPlayController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new CarPlayController({
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
