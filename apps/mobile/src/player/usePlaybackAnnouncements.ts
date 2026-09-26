// Phase 31 — announces meaningful playback changes to screen readers.
//
// Announcing every track change matters because playback can change without
// user interaction (queue advancing, remote controls, room sync). Errors are
// announced because they otherwise surface only as a tiny icon.

import { useEffect, useRef } from 'react';
import { announce } from '../components/announce';
import { usePlayback } from '../playback';

/** Announces "Now playing: <title> by <artist>" on track changes and errors. */
export function usePlaybackAnnouncements(): void {
  const { track, state, error } = usePlayback();
  const lastTrackId = useRef<string | null>(null);
  const lastError = useRef<string | null>(null);

  useEffect(() => {
    if (track && track.trackId !== lastTrackId.current) {
      lastTrackId.current = track.trackId;
      announce(`Now playing: ${track.title} by ${track.artistName}`);
    }
  }, [track]);

  useEffect(() => {
    if (state === 'error' && error && error !== lastError.current) {
      lastError.current = error;
      announce(`Playback error: ${error}`);
    } else if (state !== 'error') {
      lastError.current = null;
    }
  }, [state, error]);
}
