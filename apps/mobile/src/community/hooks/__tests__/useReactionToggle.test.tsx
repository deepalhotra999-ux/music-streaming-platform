// Phase 29 — useReactionToggle: optimistic flip, server reconciliation,
// and rollback on failure.

import { act, renderHook } from '@testing-library/react-native';
import type { ApiClient, ArtistPost, ReactionResult } from '../../../api';
import { useReactionToggle } from '../useReactionToggle';

jest.mock('../../../api', () => {
  const actual = jest.requireActual('../../../api');
  return { ...actual, addReaction: jest.fn(), removeReaction: jest.fn() };
});

import { addReaction, removeReaction } from '../../../api';

const mockedAdd = addReaction as jest.MockedFunction<typeof addReaction>;
const mockedRemove = removeReaction as jest.MockedFunction<typeof removeReaction>;

function makePost(overrides: Partial<ArtistPost> = {}): ArtistPost {
  return {
    id: 'post-1',
    body: 'Hello',
    author: { id: 'user-1', displayName: 'The Band', avatarUrl: null },
    artist: { id: 'artist-1', name: 'The Band', verified: false },
    track: null,
    album: null,
    status: 'ACTIVE',
    reactionCount: 5,
    commentCount: 0,
    viewerReacted: false,
    publishedAt: '2026-09-26T10:00:00.000Z',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  };
}

const client = {} as ApiClient;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useReactionToggle', () => {
  it('flips optimistically then reconciles with the server', async () => {
    const post = makePost();
    const result: ReactionResult = { reacted: true, reactionCount: 6 };
    mockedAdd.mockResolvedValue(result);

    const { result: hook } = renderHook(() => useReactionToggle(client));
    await act(async () => {
      await hook.current.toggle(post);
    });

    expect(mockedAdd).toHaveBeenCalledWith(client, 'post-1');
    const applied = hook.current.applyOverrides(post);
    expect(applied.viewerReacted).toBe(true);
    expect(applied.reactionCount).toBe(6);
  });

  it('removes the reaction when already reacted', async () => {
    const post = makePost({ viewerReacted: true, reactionCount: 6 });
    const result: ReactionResult = { reacted: false, reactionCount: 5 };
    mockedRemove.mockResolvedValue(result);

    const { result: hook } = renderHook(() => useReactionToggle(client));
    await act(async () => {
      await hook.current.toggle(post);
    });

    expect(mockedRemove).toHaveBeenCalledWith(client, 'post-1');
    const applied = hook.current.applyOverrides(post);
    expect(applied.viewerReacted).toBe(false);
    expect(applied.reactionCount).toBe(5);
  });

  it('rolls back the optimistic flip when the request fails', async () => {
    const post = makePost();
    mockedAdd.mockRejectedValue(new Error('offline'));

    const { result: hook } = renderHook(() => useReactionToggle(client));
    await act(async () => {
      await hook.current.toggle(post);
    });

    const applied = hook.current.applyOverrides(post);
    expect(applied.viewerReacted).toBe(false);
    expect(applied.reactionCount).toBe(5);
    expect(hook.current.pending['post-1']).toBeUndefined();
  });
});
