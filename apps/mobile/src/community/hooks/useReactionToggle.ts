// Phase 29 — shared reaction toggle with optimistic updates and rollback.
// Merges overrides into posts at render time so paginated lists don't need
// to refetch after every tap.

import { useCallback, useState } from 'react';
import type { ApiClient, ArtistPost, ReactionResult } from '../../api';
import { addReaction, removeReaction } from '../../api';

interface ReactionOverride {
  viewerReacted: boolean;
  reactionCount: number;
}

export function useReactionToggle(api: ApiClient) {
  const [overrides, setOverrides] = useState<Record<string, ReactionOverride>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const toggle = useCallback(
    async (post: ArtistPost) => {
      if (pending[post.id]) {
        return;
      }
      const base = overrides[post.id] ?? {
        viewerReacted: post.viewerReacted === true,
        reactionCount: post.reactionCount,
      };
      setPending((prev) => ({ ...prev, [post.id]: true }));
      setOverrides((prev) => ({
        ...prev,
        [post.id]: {
          viewerReacted: !base.viewerReacted,
          reactionCount: base.reactionCount + (base.viewerReacted ? -1 : 1),
        },
      }));
      try {
        const result: ReactionResult = base.viewerReacted
          ? await removeReaction(api, post.id)
          : await addReaction(api, post.id);
        setOverrides((prev) => ({
          ...prev,
          [post.id]: { viewerReacted: result.reacted, reactionCount: result.reactionCount },
        }));
      } catch {
        setOverrides((prev) => ({ ...prev, [post.id]: base }));
      } finally {
        setPending((prev) => {
          const next = { ...prev };
          delete next[post.id];
          return next;
        });
      }
    },
    [api, overrides, pending],
  );

  const applyOverrides = useCallback(
    (post: ArtistPost): ArtistPost => {
      const override = overrides[post.id];
      return override ? { ...post, ...override } : post;
    },
    [overrides],
  );

  return { applyOverrides, pending, toggle };
}
