// Phase 11 — library state: app-wide liked-track and followed-artist sets.
//
// Screens need instant like/follow feedback without refetching lists, so
// the provider bootstraps the caller's liked track ids and followed artist
// ids once (paginated, newest first) and keeps them in memory. Toggles are
// optimistic: the UI updates immediately and rolls back if the API call
// fails. Mounted only for authenticated users (see the root layout).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ApiClient, Page } from '../api';
import {
  followArtist,
  likeTrack,
  listFollowedArtists,
  listLikedTracks,
  unfollowArtist,
  unlikeTrack,
} from '../api';

const PAGE_LIMIT = 100;

async function fetchAllIds<T>(
  fetchPage: (page: number) => Promise<Page<T>>,
  mapId: (item: T) => string,
  isMounted: () => boolean,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let page = 1;
  for (;;) {
    const result = await fetchPage(page);
    if (!isMounted()) {
      return ids;
    }
    for (const item of result.data) {
      ids.add(mapId(item));
    }
    if (page >= result.pagination.totalPages) {
      return ids;
    }
    page += 1;
  }
}

export interface LibraryContextValue {
  /** True once the liked-ids bootstrap finished (successfully or not). */
  likesReady: boolean;
  /** True once the followed-ids bootstrap finished (successfully or not). */
  followsReady: boolean;
  isLiked: (trackId: string) => boolean;
  isFollowed: (artistId: string) => boolean;
  /**
   * Optimistic toggle. Updates state immediately, rolls back and rethrows
   * on API failure so the caller can surface the error.
   */
  toggleLike: (trackId: string) => Promise<void>;
  toggleFollow: (artistId: string) => Promise<void>;
  /** Re-fetch both id sets from the API (e.g. after sign-in change). */
  refresh: () => Promise<void>;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [followedIds, setFollowedIds] = useState<Set<string>>(new Set());
  const [likesReady, setLikesReady] = useState(false);
  const [followsReady, setFollowsReady] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  const bootstrap = useCallback(async (mounted: () => boolean) => {
    setLikesReady(false);
    setFollowsReady(false);
    try {
      const ids = await fetchAllIds(
        (page) => listLikedTracks(apiRef.current, { page, limit: PAGE_LIMIT }),
        (item) => item.trackId,
        mounted,
      );
      if (mounted()) {
        setLikedIds(ids);
      }
    } catch {
      // A failed bootstrap must not break the app; toggles still work and
      // will reconcile state on success.
    } finally {
      if (mounted()) {
        setLikesReady(true);
      }
    }
    try {
      const ids = await fetchAllIds(
        (page) => listFollowedArtists(apiRef.current, { page, limit: PAGE_LIMIT }),
        (item) => item.artistId,
        mounted,
      );
      if (mounted()) {
        setFollowedIds(ids);
      }
    } catch {
      // Same as above: degrade to toggle-only state.
    } finally {
      if (mounted()) {
        setFollowsReady(true);
      }
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    void bootstrap(() => mounted);
    return () => {
      mounted = false;
    };
  }, [bootstrap]);

  const refresh = useCallback(async () => {
    await bootstrap(() => true);
  }, [bootstrap]);

  const toggleLike = useCallback(async (trackId: string) => {
    const wasLiked = likedIds.has(trackId);
    setLikedIds((prev) => {
      const next = new Set(prev);
      if (wasLiked) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
    try {
      if (wasLiked) {
        await unlikeTrack(apiRef.current, trackId);
      } else {
        await likeTrack(apiRef.current, trackId);
      }
    } catch (err) {
      setLikedIds((prev) => {
        const next = new Set(prev);
        if (wasLiked) {
          next.add(trackId);
        } else {
          next.delete(trackId);
        }
        return next;
      });
      throw err;
    }
  }, [likedIds]);

  const toggleFollow = useCallback(async (artistId: string) => {
    const wasFollowed = followedIds.has(artistId);
    setFollowedIds((prev) => {
      const next = new Set(prev);
      if (wasFollowed) {
        next.delete(artistId);
      } else {
        next.add(artistId);
      }
      return next;
    });
    try {
      if (wasFollowed) {
        await unfollowArtist(apiRef.current, artistId);
      } else {
        await followArtist(apiRef.current, artistId);
      }
    } catch (err) {
      setFollowedIds((prev) => {
        const next = new Set(prev);
        if (wasFollowed) {
          next.add(artistId);
        } else {
          next.delete(artistId);
        }
        return next;
      });
      throw err;
    }
  }, [followedIds]);

  const value = useMemo<LibraryContextValue>(
    () => ({
      likesReady,
      followsReady,
      isLiked: (trackId: string) => likedIds.has(trackId),
      isFollowed: (artistId: string) => followedIds.has(artistId),
      toggleLike,
      toggleFollow,
      refresh,
    }),
    [likesReady, followsReady, likedIds, followedIds, toggleLike, toggleFollow, refresh],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) {
    throw new Error('useLibrary must be used inside a LibraryProvider.');
  }
  return value;
}
