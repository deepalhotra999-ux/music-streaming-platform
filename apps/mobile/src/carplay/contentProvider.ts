// Phase 23 — CarPlay content provider.
//
// Maps the existing catalog/library APIs onto the narrow JSON payloads
// the native CarPlay templates consume. Rules the provider enforces:
//
// - Only public catalog surfaces + the signed-in user's own library.
//   Private playlists are resolved through getPlaylist, whose server-side
//   404 keeps non-owned private content out of the car.
// - Only tracks with status READY are ever offered for playback. The
//   controller always refreshes the node's track listing before queueing
//   a tap, so TAKEDOWN/deleted tracks fail safe instead of playing a
//   stale entry.
// - Empty nodes return a friendly message item, never an empty list.
// - The provider never plays anything; it only describes content.

import type { ApiClient } from '../api';
import {
  getAlbum,
  getArtist,
  getPlaylist,
  listAlbums,
  listArtists,
  listPublicPlaylists,
  listTracks,
} from '../api/catalog';
import { listFollowedArtists, listHistory, listLikedTracks, listMyPlaylists } from '../api/library';
import type { AlbumTrack, PlaylistItem, TrackStatus, TrackSummary } from '../api/types';
import type { RepeatMode } from '../playback/types';
import type {
  CarPlayItemPayload,
  CarPlaySectionPayload,
  CarPlayTabPayload,
} from 'waveform-carplay';
import { albumNodeId, artistNodeId, playlistNodeId, splitNodeId, trackItemId } from './identifiers';

/** Playback modes the provider needs to render Library action rows. */
export interface CarPlayPlaybackModes {
  shuffle: boolean;
  repeatMode: RepeatMode;
}

export interface CarPlayNode {
  title: string;
  sections: CarPlaySectionPayload[];
}

/** Nodes that behave as track lists (selecting a track queues the list). */
const TRACK_LIST_NODES = new Set(['home', 'liked', 'history']);

function isReadyTrack(status: TrackStatus | string): boolean {
  return status === 'READY';
}

/** Keep the first occurrence of each READY track, preserving order. */
function dedupeReady(tracks: TrackSummary[]): TrackSummary[] {
  const seen = new Set<string>();
  const out: TrackSummary[] = [];
  for (const track of tracks) {
    if (isReadyTrack(track.status) && !seen.has(track.id)) {
      seen.add(track.id);
      out.push(track);
    }
  }
  return out;
}

function trackItem(track: TrackSummary, nodeId: string): CarPlayItemPayload {
  return {
    id: trackItemId(track.id),
    kind: 'track',
    title: track.title,
    subtitle: track.artistName,
    target: nodeId,
  };
}

function containerItem(
  id: string,
  title: string,
  subtitle: string | undefined,
  nodeId: string,
): CarPlayItemPayload {
  return { id, kind: 'container', title, subtitle, target: nodeId };
}

function actionItem(
  id: string,
  title: string,
  subtitle: string,
  command: string,
): CarPlayItemPayload {
  return { id, kind: 'action', title, subtitle, target: command };
}

function messageItem(id: string, title: string, subtitle?: string): CarPlayItemPayload {
  return { id, kind: 'message', title, subtitle };
}

function albumTrackToSummary(
  album: { id: string; title: string; artistId: string; artistName: string },
  t: AlbumTrack,
): TrackSummary {
  return {
    id: t.id,
    title: t.title,
    durationMs: t.durationMs,
    status: t.status as TrackStatus,
    artistId: album.artistId,
    artistName: album.artistName,
    albumId: album.id,
    albumTitle: album.title,
  };
}

function playlistItemToSummary(item: PlaylistItem): TrackSummary {
  return { ...item.track };
}

function repeatModeLabel(mode: RepeatMode): string {
  switch (mode) {
    case 'all':
      return 'All';
    case 'one':
      return 'One';
    default:
      return 'Off';
  }
}

export class CarPlayContentProvider {
  /**
   * Playable tracks per track-list node, populated whenever a node is
   * fetched. The controller reads this for queue building; misses force
   * a re-fetch so takedowns and deletions fail safe.
   */
  private readonly trackCache = new Map<string, TrackSummary[]>();

  constructor(private readonly api: ApiClient) {}

  /** The four root tabs, fully populated. */
  async getTabs(modes: CarPlayPlaybackModes): Promise<CarPlayTabPayload[]> {
    const [home, library, artists, playlists] = await Promise.all([
      this.homeSections(),
      this.librarySections(modes),
      this.artistsSections(),
      this.playlistsSections(),
    ]);
    return [
      { nodeId: 'home', title: 'Home', sections: home },
      { nodeId: 'library', title: 'Library', sections: library },
      { nodeId: 'artists', title: 'Artists', sections: artists },
      { nodeId: 'playlists', title: 'Playlists', sections: playlists },
    ];
  }

  /** Content for one node id (tab root or drill-down container). */
  async getNode(nodeId: string, modes: CarPlayPlaybackModes): Promise<CarPlayNode> {
    const split = splitNodeId(nodeId);
    if (!split) {
      throw new Error('Unknown CarPlay node');
    }
    switch (split.base) {
      case 'home':
        return { title: 'Home', sections: await this.homeSections() };
      case 'library':
        return { title: 'Library', sections: await this.librarySections(modes) };
      case 'artists':
        return { title: 'Artists', sections: await this.artistsSections() };
      case 'playlists':
        return { title: 'Playlists', sections: await this.playlistsSections() };
      case 'liked':
        return { title: 'Liked Songs', sections: await this.likedSections() };
      case 'history':
        return { title: 'Recently Played', sections: await this.historySections() };
      case 'myplaylists':
        return { title: 'My Playlists', sections: await this.myPlaylistsSections() };
      case 'followedArtists':
        return { title: 'Followed Artists', sections: await this.followedArtistsSections() };
      case 'album':
        if (split.parameter) {
          return this.albumNode(split.parameter);
        }
        break;
      case 'playlist':
        if (split.parameter) {
          return this.playlistNode(split.parameter);
        }
        break;
      case 'artist':
        if (split.parameter) {
          return this.artistNode(split.parameter);
        }
        break;
    }
    throw new Error('Unknown CarPlay node');
  }

  /** Cached playable tracks for a node; null when never fetched. */
  getCachedTracks(nodeId: string): TrackSummary[] | null {
    return this.trackCache.get(nodeId) ?? null;
  }

  /** Playable tracks for a node, fetching on cache miss. */
  async getNodeTracks(nodeId: string, modes: CarPlayPlaybackModes): Promise<TrackSummary[]> {
    const cached = this.getCachedTracks(nodeId);
    if (cached) {
      return cached;
    }
    await this.getNode(nodeId, modes);
    return this.getCachedTracks(nodeId) ?? [];
  }

  /** Playable tracks for a node, always re-fetched (takedown safety net). */
  async refreshNodeTracks(nodeId: string, modes: CarPlayPlaybackModes): Promise<TrackSummary[]> {
    this.trackCache.delete(nodeId);
    return this.getNodeTracks(nodeId, modes);
  }

  private rememberTracks(nodeId: string, tracks: TrackSummary[]): void {
    if (TRACK_LIST_NODES.has(nodeId) || nodeId.includes(':')) {
      this.trackCache.set(nodeId, tracks);
    }
  }

  // --- Tab content builders ------------------------------------------------

  private async homeSections(): Promise<CarPlaySectionPayload[]> {
    const [history, albums, playlists] = await Promise.all([
      listHistory(this.api, { limit: 8 }),
      listAlbums(this.api, { limit: 8 }),
      listPublicPlaylists(this.api, { limit: 8 }),
    ]);

    const seen = new Set<string>();
    const recentTracks: TrackSummary[] = [];
    for (const entry of history.data) {
      if (isReadyTrack(entry.track.status) && !seen.has(entry.track.id)) {
        seen.add(entry.track.id);
        recentTracks.push(entry.track);
      }
    }
    this.rememberTracks('home', recentTracks);

    const sections: CarPlaySectionPayload[] = [];
    sections.push({
      title: recentTracks.length > 0 ? 'Recently Played' : undefined,
      items:
        recentTracks.length > 0
          ? recentTracks.map((t) => trackItem(t, 'home'))
          : [messageItem('msg:home-empty', 'Nothing here yet', 'Play something in the app first.')],
    });
    if (albums.data.length > 0) {
      sections.push({
        title: 'New Releases',
        items: albums.data.map((a) =>
          containerItem(`album-row:${a.id}`, a.title, a.artistName, albumNodeId(a.id)),
        ),
      });
    }
    if (playlists.data.length > 0) {
      sections.push({
        title: 'Featured Playlists',
        items: playlists.data.map((p) =>
          containerItem(
            `playlist-row:${p.id}`,
            p.title,
            `${p.trackCount} songs`,
            playlistNodeId(p.id),
          ),
        ),
      });
    }
    return sections;
  }

  private async librarySections(modes: CarPlayPlaybackModes): Promise<CarPlaySectionPayload[]> {
    return [
      {
        title: 'Your Library',
        items: [
          containerItem('node:liked', 'Liked Songs', undefined, 'liked'),
          containerItem('node:history', 'Recently Played', undefined, 'history'),
          containerItem('node:myplaylists', 'My Playlists', undefined, 'myplaylists'),
          containerItem('node:followedArtists', 'Followed Artists', undefined, 'followedArtists'),
        ],
      },
      {
        title: 'Playback',
        items: [
          actionItem('action:shuffle', 'Shuffle', modes.shuffle ? 'On' : 'Off', 'shuffle'),
          actionItem('action:repeat', 'Repeat', repeatModeLabel(modes.repeatMode), 'repeat'),
        ],
      },
    ];
  }

  private async artistsSections(): Promise<CarPlaySectionPayload[]> {
    const artists = await listArtists(this.api, { limit: 50 });
    return [
      {
        items:
          artists.data.length > 0
            ? artists.data.map((a) =>
                containerItem(
                  `artist-row:${a.id}`,
                  a.name,
                  a.verified ? 'Verified' : undefined,
                  artistNodeId(a.id),
                ),
              )
            : [messageItem('msg:artists-empty', 'No artists found')],
      },
    ];
  }

  private async playlistsSections(): Promise<CarPlaySectionPayload[]> {
    const [mine, featured] = await Promise.all([
      listMyPlaylists(this.api, { limit: 25 }),
      listPublicPlaylists(this.api, { limit: 25 }),
    ]);
    const sections: CarPlaySectionPayload[] = [];
    sections.push({
      title: 'My Playlists',
      items:
        mine.data.length > 0
          ? mine.data.map((p) =>
              containerItem(
                `myplaylist-row:${p.id}`,
                p.title,
                `${p.trackCount} songs`,
                playlistNodeId(p.id),
              ),
            )
          : [messageItem('msg:myplaylists-empty', 'No playlists yet', 'Create one in the app.')],
    });
    if (featured.data.length > 0) {
      sections.push({
        title: 'Featured',
        items: featured.data.map((p) =>
          containerItem(
            `playlist-row:${p.id}`,
            p.title,
            `${p.trackCount} songs`,
            playlistNodeId(p.id),
          ),
        ),
      });
    }
    return sections;
  }

  // --- Drill-down builders --------------------------------------------------

  private async likedSections(): Promise<CarPlaySectionPayload[]> {
    const liked = await listLikedTracks(this.api, { limit: 100 });
    const tracks = dedupeReady(liked.data.map((l) => l.track));
    this.rememberTracks('liked', tracks);
    return [
      {
        items:
          tracks.length > 0
            ? tracks.map((t) => trackItem(t, 'liked'))
            : [messageItem('msg:liked-empty', 'No liked songs yet', 'Like songs in the app.')],
      },
    ];
  }

  private async historySections(): Promise<CarPlaySectionPayload[]> {
    const history = await listHistory(this.api, { limit: 100 });
    const tracks = dedupeReady(history.data.map((h) => h.track));
    this.rememberTracks('history', tracks);
    return [
      {
        items:
          tracks.length > 0
            ? tracks.map((t) => trackItem(t, 'history'))
            : [messageItem('msg:history-empty', 'Nothing played yet')],
      },
    ];
  }

  private async myPlaylistsSections(): Promise<CarPlaySectionPayload[]> {
    const mine = await listMyPlaylists(this.api, { limit: 50 });
    return [
      {
        items:
          mine.data.length > 0
            ? mine.data.map((p) =>
                containerItem(
                  `myplaylist-row:${p.id}`,
                  p.title,
                  `${p.trackCount} songs`,
                  playlistNodeId(p.id),
                ),
              )
            : [messageItem('msg:myplaylists-empty', 'No playlists yet', 'Create one in the app.')],
      },
    ];
  }

  private async followedArtistsSections(): Promise<CarPlaySectionPayload[]> {
    const followed = await listFollowedArtists(this.api, { limit: 50 });
    return [
      {
        items:
          followed.data.length > 0
            ? followed.data.map((f) =>
                containerItem(
                  `artist-row:${f.artist.id}`,
                  f.artist.name,
                  undefined,
                  artistNodeId(f.artist.id),
                ),
              )
            : [messageItem('msg:followed-empty', 'No followed artists yet')],
      },
    ];
  }

  private async albumNode(albumId: string): Promise<CarPlayNode> {
    // 404/403 propagate to the controller, which shows a CarPlay alert —
    // an unpublished or missing album never renders.
    const album = await getAlbum(this.api, albumId);
    const nodeId = albumNodeId(albumId);
    const tracks = album.tracks
      .slice()
      .sort((a, b) => a.discNumber - b.discNumber || (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
      .map((t) => albumTrackToSummary(album, t))
      .filter((t) => isReadyTrack(t.status));
    this.rememberTracks(nodeId, tracks);
    return {
      title: album.title,
      sections: [
        {
          items:
            tracks.length > 0
              ? tracks.map((t) => trackItem(t, nodeId))
              : [messageItem('msg:album-empty', 'No playable tracks')],
        },
      ],
    };
  }

  private async playlistNode(playlistId: string): Promise<CarPlayNode> {
    // Private playlists the user cannot see fail server-side (404) before
    // anything renders — the car never learns they exist.
    const playlist = await getPlaylist(this.api, playlistId);
    const nodeId = playlistNodeId(playlistId);
    const tracks = playlist.items
      .map((item) => playlistItemToSummary(item))
      .filter((t) => isReadyTrack(t.status));
    this.rememberTracks(nodeId, tracks);
    return {
      title: playlist.title,
      sections: [
        {
          items:
            tracks.length > 0
              ? tracks.map((t) => trackItem(t, nodeId))
              : [messageItem('msg:playlist-empty', 'No playable tracks')],
        },
      ],
    };
  }

  private async artistNode(artistId: string): Promise<CarPlayNode> {
    const [artist, tracks, albums] = await Promise.all([
      getArtist(this.api, artistId),
      listTracks(this.api, { artistId, limit: 25 }),
      listAlbums(this.api, { artistId, limit: 25 }),
    ]);
    const nodeId = artistNodeId(artistId);
    const playable = tracks.data.filter((t) => isReadyTrack(t.status));
    this.rememberTracks(nodeId, playable);
    const sections: CarPlaySectionPayload[] = [];
    sections.push({
      title: playable.length > 0 ? 'Top Tracks' : undefined,
      items:
        playable.length > 0
          ? playable.map((t) => trackItem(t, nodeId))
          : [messageItem('msg:artist-empty', 'No playable tracks')],
    });
    if (albums.data.length > 0) {
      sections.push({
        title: 'Albums',
        items: albums.data.map((a) =>
          containerItem(`album-row:${a.id}`, a.title, undefined, albumNodeId(a.id)),
        ),
      });
    }
    return { title: artist.name, sections };
  }
}
