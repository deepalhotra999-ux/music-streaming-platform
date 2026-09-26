// Phase 31 — announces download completions and failures to screen readers.
//
// Downloads run in the background; without an announcement a VoiceOver user
// never learns a track became available offline (or failed).

import { useEffect, useRef } from 'react';
import { announce } from '../components/announce';
import type { DownloadRecord } from './types';

type TerminalState = 'complete' | 'failed';

/** Announces when a download reaches a terminal state. */
export function useDownloadAnnouncements(downloads: DownloadRecord[]): void {
  const seen = useRef<Map<string, TerminalState>>(new Map());
  const baselineDone = useRef(false);

  useEffect(() => {
    // On first run, record existing terminal states as the baseline without
    // announcing: the user already knows about downloads that finished while
    // the app was closed (or they predate this session).
    if (!baselineDone.current) {
      baselineDone.current = true;
      for (const d of downloads) {
        if (d.status === 'complete' || d.status === 'failed') {
          seen.current.set(d.trackId, d.status);
        }
      }
      return;
    }
    for (const d of downloads) {
      const status = d.status;
      if (status !== 'complete' && status !== 'failed') {
        continue;
      }
      if (seen.current.get(d.trackId) === status) {
        continue;
      }
      seen.current.set(d.trackId, status);
      const title = d.title || 'track';
      if (status === 'complete') {
        announce(`Download complete: ${title} is available offline`);
      } else {
        announce(`Download failed: ${title}. You can retry from your library.`);
      }
    }
  }, [downloads]);
}
