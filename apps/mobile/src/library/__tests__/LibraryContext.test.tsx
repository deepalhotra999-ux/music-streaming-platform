// Phase 11 — LibraryProvider: bootstrap of liked/followed id sets,
// optimistic toggles with rollback, and graceful bootstrap failure.

import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { useEffect } from 'react';
import type { ApiClient } from '../../api';
import { LibraryProvider, useLibrary, type LibraryContextValue } from '../LibraryContext';

function pageOf<T>(data: T[], totalPages = 1) {
  return {
    data,
    pagination: { page: 1, limit: 100, total: data.length, totalPages },
  };
}

const likeOf = (trackId: string) => ({ trackId, createdAt: '2026-01-01T00:00:00.000Z', track: {} });
const followOf = (artistId: string) => ({
  artistId,
  createdAt: '2026-01-01T00:00:00.000Z',
  artist: {},
});

interface FakeApi {
  get: jest.Mock;
  post: jest.Mock;
  delete: jest.Mock;
  api: ApiClient;
}

function fakeApi(handlers: { likes?: unknown[][]; follows?: unknown[][]; fail?: boolean }): FakeApi {
  const get = jest.fn(async (path: string) => {
    if (handlers.fail) {
      throw new Error('network down');
    }
    const page = Number(new URL(path, 'http://x').searchParams.get('page') ?? '1');
    if (path.startsWith('/v1/me/likes')) {
      const pages = handlers.likes ?? [[]];
      return pageOf(pages[page - 1] ?? [], pages.length);
    }
    if (path.startsWith('/v1/me/follows')) {
      const pages = handlers.follows ?? [[]];
      return pageOf(pages[page - 1] ?? [], pages.length);
    }
    throw new Error(`unexpected path ${path}`);
  });
  const post = jest.fn(async () => ({}));
  const del = jest.fn(async () => undefined);
  return { get, post, delete: del, api: { get, post, delete: del } as unknown as ApiClient };
}

function Probe({ onValue }: { onValue: (v: LibraryContextValue) => void }) {
  const value = useLibrary();
  useEffect(() => {
    onValue(value);
  }, [value, onValue]);
  return <Text>probe</Text>;
}

function renderProvider(fake: FakeApi) {
  let captured: LibraryContextValue | null = null;
  render(
    <LibraryProvider api={fake.api}>
      <Probe onValue={(v) => (captured = v)} />
    </LibraryProvider>,
  );
  return {
    get value(): LibraryContextValue {
      if (!captured) {
        throw new Error('context not captured');
      }
      return captured;
    },
  };
}

describe('LibraryProvider', () => {
  it('bootstraps liked and followed ids and flips the ready flags', async () => {
    const fake = fakeApi({ likes: [[likeOf('t1'), likeOf('t2')]], follows: [[followOf('a1')]] });
    const ctx = renderProvider(fake);
    await waitFor(() => expect(ctx.value.likesReady).toBe(true));
    await waitFor(() => expect(ctx.value.followsReady).toBe(true));
    expect(ctx.value.isLiked('t1')).toBe(true);
    expect(ctx.value.isLiked('t2')).toBe(true);
    expect(ctx.value.isLiked('t9')).toBe(false);
    expect(ctx.value.isFollowed('a1')).toBe(true);
    expect(ctx.value.isFollowed('a9')).toBe(false);
  });

  it('collects ids across paginated bootstrap pages', async () => {
    const fake = fakeApi({ likes: [[likeOf('t1')], [likeOf('t2')]], follows: [[]] });
    const ctx = renderProvider(fake);
    await waitFor(() => expect(ctx.value.likesReady).toBe(true));
    expect(ctx.value.isLiked('t1')).toBe(true);
    expect(ctx.value.isLiked('t2')).toBe(true);
    expect(fake.get.mock.calls.filter(([p]) => p.startsWith('/v1/me/likes')).length).toBe(2);
  });

  it('toggleLike likes optimistically and posts to the API', async () => {
    const fake = fakeApi({ likes: [[]], follows: [[]] });
    const ctx = renderProvider(fake);
    await waitFor(() => expect(ctx.value.likesReady).toBe(true));

    await ctx.value.toggleLike('t3');
    await waitFor(() => expect(ctx.value.isLiked('t3')).toBe(true));
    expect(fake.post).toHaveBeenCalledWith('/v1/me/likes', { trackId: 't3' });
  });

  it('toggleLike unlikes an already-liked track', async () => {
    const fake = fakeApi({ likes: [[likeOf('t1')]], follows: [[]] });
    const ctx = renderProvider(fake);
    await waitFor(() => expect(ctx.value.isLiked('t1')).toBe(true));

    await ctx.value.toggleLike('t1');
    await waitFor(() => expect(ctx.value.isLiked('t1')).toBe(false));
    expect(fake.delete).toHaveBeenCalledWith('/v1/me/likes/t1');
  });

  it('toggleLike rolls back and rethrows when the API fails', async () => {
    const fake = fakeApi({ likes: [[]], follows: [[]] });
    fake.post.mockRejectedValueOnce(new Error('boom'));
    const ctx = renderProvider(fake);
    await waitFor(() => expect(ctx.value.likesReady).toBe(true));

    await expect(ctx.value.toggleLike('t3')).rejects.toThrow('boom');
    await waitFor(() => expect(ctx.value.isLiked('t3')).toBe(false));
  });

  it('toggleFollow follows and unfollows with rollback on failure', async () => {
    const fake = fakeApi({ likes: [[]], follows: [[followOf('a1')]] });
    fake.post.mockRejectedValueOnce(new Error('nope'));
    const ctx = renderProvider(fake);
    await waitFor(() => expect(ctx.value.followsReady).toBe(true));

    await expect(ctx.value.toggleFollow('a2')).rejects.toThrow('nope');
    await waitFor(() => expect(ctx.value.isFollowed('a2')).toBe(false));

    await ctx.value.toggleFollow('a1');
    await waitFor(() => expect(ctx.value.isFollowed('a1')).toBe(false));
    expect(fake.delete).toHaveBeenCalledWith('/v1/me/follows/a1');
  });

  it('a failed bootstrap still flips ready and keeps toggles working', async () => {
    const fake = fakeApi({ fail: true });
    const ctx = renderProvider(fake);
    await waitFor(() => expect(ctx.value.likesReady).toBe(true));
    await waitFor(() => expect(ctx.value.followsReady).toBe(true));

    await ctx.value.toggleLike('t1');
    await waitFor(() => expect(ctx.value.isLiked('t1')).toBe(true));
    expect(fake.post).toHaveBeenCalledWith('/v1/me/likes', { trackId: 't1' });
  });
});
