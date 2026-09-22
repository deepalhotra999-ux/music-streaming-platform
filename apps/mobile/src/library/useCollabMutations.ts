// Phase 27 — revision-guarded playlist mutations with conflict recovery.
//
// Collaborative playlists use optimistic concurrency: every track
// mutation carries the last-known `expectedRevision`; the server bumps
// the revision atomically and returns it in the `x-playlist-revision`
// header. A stale write fails with RFC 7807 409 and is NEVER silently
// applied. On conflict this hook refetches the playlist (new revision +
// items), raises a non-blocking notice, and reports 'conflict' so the
// caller skips its post-mutation work — the failed optimistic update is
// never committed.
//
// Non-collaborative playlists keep the legacy owner-only wrappers (no
// revision required); the hook branches on `playlist.isCollaborative` so
// screens share one call path.

import { useCallback, useRef, useState } from 'react';
import {
  addTrackCollaborative,
  addTrackToPlaylist,
  isRevisionConflict,
  movePlaylistItem,
  movePlaylistItemCollaborative,
  removePlaylistItem,
  removePlaylistItemCollaborative,
  setCollaborationEnabled as setCollaborationEnabledApi,
  type ApiClient,
  type PlaylistDetail,
  type PlaylistItem,
  type RevisionedResult,
} from '../api';

/** Non-blocking banner text shown after a revision conflict recovery. */
export const COLLAB_CONFLICT_NOTICE = 'Playlist changed by a collaborator — refreshed.';

export type CollabMutationResult = 'ok' | 'conflict';

export interface UseCollabMutationsResult {
  /** Set after a conflict recovery; clear it when starting a new mutation. */
  notice: string | null;
  clearNotice: () => void;
  /** Add a track (revision-guarded when collaborative). */
  addTrack: (trackId: string, position?: number) => Promise<CollabMutationResult>;
  /** Remove a track item (revision-guarded when collaborative). */
  removeItem: (itemId: string) => Promise<CollabMutationResult>;
  /**
   * Swap the absolute positions of two items. In collaborative mode both
   * writes are threaded through one revision chain: the second write
   * uses the revision returned by the first.
   */
  swapItems: (a: PlaylistItem, b: PlaylistItem) => Promise<CollabMutationResult>;
  /** Owner only: toggle collaboration, then refetch. */
  setCollaboration: (enabled: boolean) => Promise<void>;
}

export function useCollabMutations(
  api: ApiClient,
  playlistId: string,
  playlist: PlaylistDetail | null,
  reload: () => Promise<void>,
): UseCollabMutationsResult {
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const [notice, setNotice] = useState<string | null>(null);

  const clearNotice = useCallback(() => setNotice(null), []);

  /**
   * Run a revision-guarded write. On 409 the playlist is refetched, the
   * notice is raised, and 'conflict' is returned instead of throwing —
   * the caller's optimistic update must be skipped in that case.
   */
  const guard = useCallback(
    async <T>(op: (revision: number) => Promise<T>): Promise<T | 'conflict'> => {
      const revision = playlistRef.current?.revision ?? 0;
      try {
        return await op(revision);
      } catch (err) {
        if (isRevisionConflict(err)) {
          await reloadRef.current();
          setNotice(COLLAB_CONFLICT_NOTICE);
          return 'conflict';
        }
        throw err;
      }
    },
    [],
  );

  const isCollaborative = useCallback(() => playlistRef.current?.isCollaborative === true, []);

  const addTrack = useCallback(
    async (trackId: string, position?: number): Promise<CollabMutationResult> => {
      if (!isCollaborative()) {
        await addTrackToPlaylist(api, playlistId, { trackId, position });
        await reloadRef.current();
        return 'ok';
      }
      const result = await guard((revision) =>
        addTrackCollaborative(api, playlistId, { trackId, position, expectedRevision: revision }),
      );
      if (result === 'conflict') {
        return 'conflict';
      }
      await reloadRef.current();
      return 'ok';
    },
    [api, playlistId, guard, isCollaborative],
  );

  const removeItem = useCallback(
    async (itemId: string): Promise<CollabMutationResult> => {
      if (!isCollaborative()) {
        await removePlaylistItem(api, playlistId, itemId);
        await reloadRef.current();
        return 'ok';
      }
      const result: number | 'conflict' = await guard((revision) =>
        removePlaylistItemCollaborative(api, playlistId, itemId, revision),
      );
      if (result === 'conflict') {
        return 'conflict';
      }
      await reloadRef.current();
      return 'ok';
    },
    [api, playlistId, guard, isCollaborative],
  );

  const swapItems = useCallback(
    async (a: PlaylistItem, b: PlaylistItem): Promise<CollabMutationResult> => {
      if (!isCollaborative()) {
        await movePlaylistItem(api, playlistId, a.id, b.position);
        await movePlaylistItem(api, playlistId, b.id, a.position);
        await reloadRef.current();
        return 'ok';
      }
      const result = await guard(async (revision): Promise<RevisionedResult<PlaylistItem>> => {
        const first = await movePlaylistItemCollaborative(api, playlistId, a.id, {
          position: b.position,
          expectedRevision: revision,
        });
        return movePlaylistItemCollaborative(api, playlistId, b.id, {
          position: a.position,
          expectedRevision: first.revision,
        });
      });
      if (result === 'conflict') {
        return 'conflict';
      }
      await reloadRef.current();
      return 'ok';
    },
    [api, playlistId, guard, isCollaborative],
  );

  const setCollaboration = useCallback(
    async (enabled: boolean): Promise<void> => {
      await setCollaborationEnabledApi(api, playlistId, enabled);
      await reloadRef.current();
    },
    [api, playlistId],
  );

  return { notice, clearNotice, addTrack, removeItem, swapItems, setCollaboration };
}
