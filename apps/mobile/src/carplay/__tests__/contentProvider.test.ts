// Phase 23 — CarPlayContentProvider unit tests.
//
// Real ApiClient over a stubbed fetch, so the provider is tested against
// the exact endpoints it consumes. Pins:
//  - tab/node structure and id conventions the Swift coordinator expects,
//  - READY-only filtering (TAKEDOWN / FAILED / PROCESSING never offered),
//  - empty-content message items (never empty lists),
//  - track cache population for queue building,
//  - private playlist 404 surfacing as an error (no content rendered).

import { ApiClient } from '../../api/client';
import type { TrackSummary } from '../../api/types';
import { CarPlayContentProvider } from '../contentProvider';

// -- stub transport --------------------------------------------------------

function ok(data: unknown) {
  return { status: 200, ok: true, json: async () => data };
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

// -- tests ------------------------------------------------------------------

describe('CarPlayContentProvider', () => {
  test('getTabs returns the four driver-oriented root tabs', async () => {
    const api = createApi(EMPTY_PAGE);
    const provider = new CarPlayContentProvider(api);
    const tabs = await provider.getTabs({ shuffle: false, repeatMode: 'off' });

    expect(tabs.map((t) => t.nodeId)).toEqual(['home', 'library', 'artists', 'playlists']);
    expect(tabs.map((t) => t.title)).toEqual(['Home', 'Library', 'Artists', 'Playlists']);
    for (const tab of tabs) {
      expect(tab.sections.length).toBeGreaterThan(0);
    }
  });

  test('library tab exposes shuffle/repeat actions with current modes', async () => {
    const api = createApi(EMPTY_PAGE);
    const provider = new CarPlayContentProvider(api);
    const tabs = await provider.getTabs({ shuffle: true, repeatMode: 'one' });
    const library = tabs.find((t) => t.nodeId === 'library')!;
    const items = library.sections.flatMap((s) => s.items);
    const shuffle = items.find((i) => i.id === 'action:shuffle')!;
    const repeat = items.find((i) => i.id === 'action:repeat')!;
    expect(shuffle.kind).toBe('action');
    expect(shuffle.subtitle).toBe('On');
    expect(shuffle.target).toBe('shuffle');
    expect(repeat.subtitle).toBe('One');
    expect(repeat.target).toBe('repeat');
  });

  test('home tab shows recent tracks and caches them for queue building', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/me/history')) {
        return page([
          {
            id: 'h1',
            trackId: 't1',
            playedAt: '2026-01-01',
            progressMs: 0,
            completed: true,
            track: track('t1'),
          },
          {
            id: 'h2',
            trackId: 't2',
            playedAt: '2026-01-01',
            progressMs: 0,
            completed: true,
            track: track('t2'),
          },
        ]);
      }
      return page([]);
    });
    const provider = new CarPlayContentProvider(api);
    const node = await provider.getNode('home', { shuffle: false, repeatMode: 'off' });

    const items = node.sections[0].items;
    expect(items.map((i) => i.id)).toEqual(['track:t1', 'track:t2']);
    expect(items[0].kind).toBe('track');
    expect(items[0].target).toBe('home');
    expect(provider.getCachedTracks('home')!.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  test('non-READY tracks are filtered out of every track list', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/me/history')) {
        return page([
          {
            id: 'h1',
            trackId: 't1',
            playedAt: '2026-01-01',
            progressMs: 0,
            completed: true,
            track: track('t1', 'READY'),
          },
          {
            id: 'h2',
            trackId: 't2',
            playedAt: '2026-01-01',
            progressMs: 0,
            completed: true,
            track: track('t2', 'TAKEDOWN'),
          },
          {
            id: 'h3',
            trackId: 't3',
            playedAt: '2026-01-01',
            progressMs: 0,
            completed: true,
            track: track('t3', 'FAILED'),
          },
          {
            id: 'h4',
            trackId: 't4',
            playedAt: '2026-01-01',
            progressMs: 0,
            completed: true,
            track: track('t4', 'PROCESSING'),
          },
        ]);
      }
      return page([]);
    });
    const provider = new CarPlayContentProvider(api);
    const node = await provider.getNode('home', { shuffle: false, repeatMode: 'off' });

    expect(node.sections[0].items.map((i) => i.id)).toEqual(['track:t1']);
    expect(provider.getCachedTracks('home')!.map((t) => t.id)).toEqual(['t1']);
  });

  test('empty nodes return a message item, never an empty list', async () => {
    const api = createApi(EMPTY_PAGE);
    const provider = new CarPlayContentProvider(api);
    for (const nodeId of ['home', 'liked', 'history', 'myplaylists', 'followedArtists']) {
      const node = await provider.getNode(nodeId, { shuffle: false, repeatMode: 'off' });
      const items = node.sections.flatMap((s) => s.items);
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((i) => i.kind === 'message' || i.kind === 'container')).toBe(true);
      expect(items.every((i) => i.kind !== 'track')).toBe(true);
    }
  });

  test('album node sorts by disc/track number and caches READY tracks', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/albums/album1')) {
        return ok({
          id: 'album1',
          title: 'Album One',
          artistId: 'artist1',
          artistName: 'Artist One',
          tracks: [
            { id: 'a2', title: 'B', durationMs: 1, status: 'READY', discNumber: 1, trackNumber: 2 },
            { id: 'a1', title: 'A', durationMs: 1, status: 'READY', discNumber: 1, trackNumber: 1 },
            {
              id: 'a3',
              title: 'C',
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
    const provider = new CarPlayContentProvider(api);
    const node = await provider.getNode('album:album1', { shuffle: false, repeatMode: 'off' });

    expect(node.title).toBe('Album One');
    expect(node.sections[0].items.map((i) => i.id)).toEqual(['track:a1', 'track:a2']);
    expect(provider.getCachedTracks('album:album1')!.map((t) => t.id)).toEqual(['a1', 'a2']);
  });

  test('playlist node 404 propagates (private playlists never render)', async () => {
    const api = createApi((url) => {
      if (url.includes('/v1/playlists/p-private')) {
        return {
          status: 404,
          ok: false,
          json: async () => ({ title: 'Not Found', detail: 'nope' }),
        };
      }
      return page([]);
    });
    const provider = new CarPlayContentProvider(api);
    await expect(
      provider.getNode('playlist:p-private', { shuffle: false, repeatMode: 'off' }),
    ).rejects.toThrow();
  });

  test('unknown node ids throw', async () => {
    const api = createApi(EMPTY_PAGE);
    const provider = new CarPlayContentProvider(api);
    await expect(
      provider.getNode('nonsense', { shuffle: false, repeatMode: 'off' }),
    ).rejects.toThrow('Unknown CarPlay node');
    await expect(provider.getNode('album:', { shuffle: false, repeatMode: 'off' })).rejects.toThrow(
      'Unknown CarPlay node',
    );
  });

  test('artist node exposes top tracks and album containers', async () => {
    const api = createApi((url) => {
      if (url.endsWith('/v1/artists/artist1')) {
        return ok({ id: 'artist1', name: 'Artist One', verified: true });
      }
      if (url.includes('/v1/tracks')) {
        return page([track('t1'), track('t2', 'TAKEDOWN')]);
      }
      if (url.includes('/v1/albums')) {
        return page([
          { id: 'album1', title: 'Album One', artistId: 'artist1', artistName: 'Artist One' },
        ]);
      }
      return page([]);
    });
    const provider = new CarPlayContentProvider(api);
    const node = await provider.getNode('artist:artist1', { shuffle: false, repeatMode: 'off' });

    expect(node.title).toBe('Artist One');
    const items = node.sections.flatMap((s) => s.items);
    const trackRows = items.filter((i) => i.kind === 'track');
    const containers = items.filter((i) => i.kind === 'container');
    expect(trackRows.map((i) => i.id)).toEqual(['track:t1']);
    expect(containers[0].target).toBe('album:album1');
  });
});
