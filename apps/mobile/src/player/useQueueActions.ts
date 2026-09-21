// Phase 9 — queue-building helpers used by catalog screens.
//
// These wrap the engine's raw setQueue/enqueue so every screen builds the
// same QueueTrack shape (via toQueueTrack) and starts playback the same
// way: select the tapped track's index into the queue, then hand the queue
// to the engine. Adding a track enqueues it without disturbing playback.

import { useCallback } from 'react';
import type { TrackSummary } from '../api';
import type { QueueTrack } from '../playback/types';
import { toQueueTrack } from '../playback/types';
import { usePlayback } from '../playback';

export interface QueueActions {
  /** Replace the queue with `tracks` and start playing `startIndex`. */
  playTracks: (tracks: TrackSummary[], startIndex?: number) => Promise<void>;
  /** Append `track` to the end of the current queue (starts it if idle). */
  addToQueue: (track: TrackSummary) => Promise<void>;
}

export function useQueueActions(): QueueActions {
  const playback = usePlayback();

  const playTracks = useCallback<QueueActions['playTracks']>(
    async (tracks, startIndex = 0) => {
      const queue: QueueTrack[] = tracks.map(toQueueTrack);
      if (queue.length === 0) {
        return;
      }
      const clamped = Math.min(Math.max(0, startIndex), queue.length - 1);
      await playback.setQueue(queue, clamped);
    },
    [playback],
  );

  const addToQueue = useCallback<QueueActions['addToQueue']>(
    async (track) => {
      await playback.enqueue(toQueueTrack(track));
    },
    [playback],
  );

  return { playTracks, addToQueue };
}
