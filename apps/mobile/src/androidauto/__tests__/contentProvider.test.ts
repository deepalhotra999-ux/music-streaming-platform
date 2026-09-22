// Phase 24 — AndroidAutoContentProvider unit tests.
//
// Real ApiClient over a stubbed fetch, so the provider is tested against
// the exact endpoints it consumes. Pins:
//  - root children: the six required browse nodes,
//  - READY-only filtering (TAKEDOWN / FAILED / PROCESSING never offered),
//  - empty nodes render a message row, never an empty list,
//  - track cache + advertised registry for queue building and onGetItem,
//  - pagination slicing,
//  - private playlist 404 surfacing as an error (no content rendered),
//  - unknown parent ids rejected (native must not serve foreign ids).

import { ApiClient } from '../../api/client';
import type { TrackSummary } from '../../api/types';
import { AndroidAutoContentProvider } from '../contentProvider';

function ok(data: unknown) {
  return { status: 200, ok: true, json: async () => data };
}

function fail(status: number) {
  return { status, ok: false, json: async () => ({ error: 'x' }) };
}

function page<T>(data: T[]) {
  return ok({ data, pagination: { page: 1, limit: 50, total: data.length, totalPages: 1 } });
}

function track(id: string, status = 'READY', title = `Track ${id}`): TrackSummary {
  return {
    id,
    title,
    durationMs: 180000,
    status,
    artistId: 'artist1',
    artistName: 'Artist One',
    albumId: 'album1',
    albumTitle: 'Album One',
  };
}

type RouteHandler = (url: string) => { status: number; ok: boolean; json: () => Promise<unknown> };

function createApi(handler: RouteHandler): ApiClient {
  return new ApiClient({
    baseUrl: 'http://test.local',
    fetchFn: (async (url: string) => handler(url)) as typeof fetch,
  });
}

const EMPTY_PAGE: RouteHandler = () => page([]);

describe('AndroidAutoContentProvider', () => {
  test('root exposes the six required browse nodes', async () => {
    const provider = new AndroidAutoContentProvider(createApi(EMPTY_PAGE));
    const result = await provider.getChildren('waveform:root', 0, 50);
    expect(result.ok).toBe(true);
    expect(result.items.map((i) => i.mediaId)).toEqual([
      'waveform:home',
      'waveform:recent',
      'waveform:liked',
      'waveform:playlists',
      'waveform:artists',
      'waveform:albums',
    ]);
    for (const item of result.items) {
      expect(item.browsable).toBe(true);
      expect(item.playable).toBe(false);
    }
  });

  test('home mixes recent tracks with browsable albums and playlists', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/me/history')) {
        return page([{ track: track('t1') }, { track: track('t2') }]);
      }
      if (url.includes('/v1/albums')) {
        return page([{ id: 'a1', title: 'Album One', artistName: 'Artist One' }]);
      }
      if (url.includes('/v1/playlists/public')) {
        return page([{ id: 'p1', title: 'Playlist One', trackCount: 3 }]);
      }
      return page([]);
    });
    const provider = new AndroidAutoContentProvider(api);
    const result = await provider.getChildren('waveform:home', 0, 50);
    expect(result.items.map((i) => i.mediaId)).toEqual([
      'waveform:track:t1',
      'waveform:track:t2',
      'waveform:album:a1',
      'waveform:playlist:p1',
    ]);
    expect(result.items[0].playable).toBe(true);
    expect(result.items[2].browsable).toBe(true);
    // Queue context is cached for both tracks.
    expect(provider.getTrackNodeId('t1')).toBe('waveform:home');
    expect(provider.getCachedTracks('waveform:home')!.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  test('only READY tracks are offered; others are filtered out', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/me/likes')) {
        return page([
          { track: track('ok1', 'READY') },
          { track: track('bad1', 'TAKEDOWN') },
          { track: track('bad2', 'FAILED') },
          { track: track('bad3', 'PROCESSING') },
          { track: track('ok2', 'READY') },
          { track: track('ok1', 'READY') }, // duplicate
        ]);
      }
      return page([]);
    });
    const provider = new AndroidAutoContentProvider(api);
    const result = await provider.getChildren('waveform:liked', 0, 50);
    expect(result.items.map((i) => i.mediaId)).toEqual([
      'waveform:track:ok1',
      'waveform:track:ok2',
    ]);
  });

  test('empty nodes render a message row, never an empty list', async () => {
    const provider = new AndroidAutoContentProvider(createApi(EMPTY_PAGE));
    for (const node of ['waveform:liked', 'waveform:recent', 'waveform:albums']) {
      const result = await provider.getChildren(node, 0, 50);
      expect(result.ok).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].playable).toBe(false);
      expect(result.items[0].browsable).toBe(false);
    }
  });

  test('pagination slices the child list', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/me/likes')) {
        return page([1, 2, 3, 4, 5].map((n) => ({ track: track(`t${n}`) })));
      }
      return page([]);
    });
    const provider = new AndroidAutoContentProvider(api);
    const first = await provider.getChildren('waveform:liked', 0, 2);
    const second = await provider.getChildren('waveform:liked', 1, 2);
    const third = await provider.getChildren('waveform:liked', 2, 2);
    expect(first.items.map((i) => i.mediaId)).toEqual(['waveform:track:t1', 'waveform:track:t2']);
    expect(second.items.map((i) => i.mediaId)).toEqual(['waveform:track:t3', 'waveform:track:t4']);
    expect(third.items.map((i) => i.mediaId)).toEqual(['waveform:track:t5']);
  });

  test('album node sorts tracks and filters non-ready', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/albums/a1')) {
        return ok({
          id: 'a1',
          title: 'Album One',
          artistId: 'artist1',
          artistName: 'Artist One',
          tracks: [
            { id: 't2', title: 'B', durationMs: 1, status: 'READY', discNumber: 1, trackNumber: 2 },
            { id: 't1', title: 'A', durationMs: 1, status: 'READY', discNumber: 1, trackNumber: 1 },
            {
              id: 't9',
              title: 'X',
              durationMs: 1,
              status: 'TAKEDOWN',
              discNumber: 1,
              trackNumber: 3,
            },
          ],
        });
      }
      return page([]);
    });
    const provider = new AndroidAutoContentProvider(api);
    const result = await provider.getChildren('waveform:album:a1', 0, 50);
    expect(result.items.map((i) => i.mediaId)).toEqual(['waveform:track:t1', 'waveform:track:t2']);
    expect(provider.getTrackNodeId('t1')).toBe('waveform:album:a1');
  });

  test('playlist node resolves through the server (private 404 fails)', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/playlists/pub1')) {
        return ok({
          id: 'pub1',
          title: 'Public',
          items: [{ track: track('t1') }, { track: track('t2', 'TAKEDOWN') }],
        });
      }
      if (url.includes('/v1/playlists/priv1')) {
        return fail(404);
      }
      return page([]);
    });
    const provider = new AndroidAutoContentProvider(api);
    const good = await provider.getChildren('waveform:playlist:pub1', 0, 50);
    expect(good.items.map((i) => i.mediaId)).toEqual(['waveform:track:t1']);
    await expect(provider.getChildren('waveform:playlist:priv1', 0, 50)).rejects.toThrow();
  });

  test('artist node mixes top tracks with browsable albums', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/tracks')) {
        return page([track('t1'), track('t2', 'TAKEDOWN')]);
      }
      if (url.includes('/v1/albums')) {
        return page([{ id: 'a1', title: 'Album One', artistName: 'Artist One' }]);
      }
      return page([]);
    });
    const provider = new AndroidAutoContentProvider(api);
    const result = await provider.getChildren('waveform:artist:ar1', 0, 50);
    expect(result.items.map((i) => i.mediaId)).toEqual(['waveform:track:t1', 'waveform:album:a1']);
  });

  test('advertised registry answers onGetItem lookups', async () => {
    const api = createApi((url) =>
      url.includes('/v1/me/history') ? page([{ track: track('t1') }]) : page([]),
    );
    const provider = new AndroidAutoContentProvider(api);
    expect(provider.getAdvertisedItem('waveform:track:t1')).toBeNull();
    await provider.getChildren('waveform:recent', 0, 50);
    const item = provider.getAdvertisedItem('waveform:track:t1');
    expect(item).not.toBeNull();
    expect(item!.title).toBe('Track t1');
    expect(item!.playable).toBe(true);
  });

  test('unknown parent ids throw (foreign ids never served)', async () => {
    const provider = new AndroidAutoContentProvider(createApi(EMPTY_PAGE));
    await expect(provider.getChildren('foreign:node', 0, 50)).rejects.toThrow();
    await expect(provider.getChildren('waveform:bogus:x', 0, 50)).rejects.toThrow();
  });

  test('search cache round-trips for queue context', () => {
    const provider = new AndroidAutoContentProvider(createApi(EMPTY_PAGE));
    expect(provider.getSearchTracks('q')).toBeNull();
    provider.rememberSearch('q', [track('t1'), track('t2')]);
    expect(provider.getSearchTracks('q')!.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(provider.getSearchQueries()).toContain('q');
  });

  // Phase 27 — collaborative playlists stay read-only and playable from the
  // car: they list and resolve tracks exactly like regular playlists, and no
  // collaboration write endpoint (members, invitations, revision-guarded
  // track writes) is ever touched.
  test('collaborative playlists remain readable and playable, with no editing surface', async () => {
    const requested: string[] = [];
    const api = createApi((url) => {
      requested.push(url);
      if (url.includes('/v1/playlists/p-collab')) {
        return ok({
          id: 'p-collab',
          title: 'Party mix',
          isCollaborative: true,
          revision: 9,
          viewerRole: 'EDITOR',
          items: [{ id: 'item-1', position: 1, track: track('t1') }],
        });
      }
      if (url.includes('/v1/me/playlists')) {
        return page([
          {
            id: 'p-collab',
            title: 'Party mix',
            isCollaborative: true,
            revision: 9,
            viewerRole: 'EDITOR',
          },
        ]);
      }
      return page([]);
    });
    const provider = new AndroidAutoContentProvider(api);

    const list = await provider.getChildren('waveform:playlists', 0, 50);
    expect(list.ok).toBe(true);
    expect(list.items.map((i) => i.mediaId)).toContain('waveform:playlist:p-collab');

    const children = await provider.getChildren('waveform:playlist:p-collab', 0, 50);
    expect(children.ok).toBe(true);
    expect(children.items.map((i) => i.mediaId)).toEqual(['waveform:track:t1']);
    expect(children.items.every((i) => i.playable)).toBe(true);

    expect(requested.some((u) => /invitation|member|collaboration/.test(u))).toBe(false);
  });
});
