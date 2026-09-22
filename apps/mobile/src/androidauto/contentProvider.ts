// Phase 24 — Android Auto content provider.
//
// Maps the existing catalog/library APIs onto the flat Media3 browse tree
// the native module serves to the car host. Rules the provider enforces:
//
// - Only public catalog surfaces + the signed-in user's own library.
//   Private playlists resolve through getPlaylist, whose server-side 404
//   keeps non-owned private content out of the car.
// - Only tracks with status READY are ever offered for playback. The
//   controller always refreshes the node's track listing before queueing
//   a tap, so TAKEDOWN/deleted tracks fail safe instead of playing a
//   stale entry.
// - Empty nodes return a single friendly message row, never an empty list.
// - The provider never plays anything; it only describes content.
//
// Every emitted item is remembered in an advertised registry so
// onGetItem (and play-request context lookup) can answer without new
// network calls.

import type { AutoChildrenResult, AutoMediaItemPayload } from 'waveform-android-auto';
import type { ApiClient } from '../api';
import {
  getAlbum,
  getPlaylist,
  listAlbums,
  listArtists,
  listPublicPlaylists,
  listTracks,
} from '../api/catalog';
import { listHistory, listLikedTracks, listMyPlaylists } from '../api/library';
import type { AlbumTrack, PlaylistItem, TrackStatus, TrackSummary } from '../api/types';
import {
  AUTO_ALBUMS,
  AUTO_ARTISTS,
  AUTO_HOME,
  AUTO_LIKED,
  AUTO_PLAYLISTS,
  AUTO_RECENT,
  albumMediaId,
  artistMediaId,
  parseAutoMediaId,
  playlistMediaId,
  trackMediaId,
} from './identifiers';

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

function browsable(mediaId: string, title: string, subtitle?: string): AutoMediaItemPayload {
  return { mediaId, title, subtitle, browsable: true, playable: false };
}

function playableTrack(track: TrackSummary): AutoMediaItemPayload {
  return {
    mediaId: trackMediaId(track.id),
    title: track.title,
    subtitle: track.artistName,
    browsable: false,
    playable: true,
    durationMs: track.durationMs ?? undefined,
    artworkUrl: null,
  };
}

function messageItem(mediaId: string, title: string, subtitle?: string): AutoMediaItemPayload {
  return { mediaId, title, subtitle, browsable: false, playable: false };
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

const ROOT_CHILDREN: AutoMediaItemPayload[] = [
  browsable(AUTO_HOME, 'Home', 'Recently played, new releases, featured'),
  browsable(AUTO_RECENT, 'Recently Played'),
  browsable(AUTO_LIKED, 'Liked Songs'),
  browsable(AUTO_PLAYLISTS, 'Playlists', 'Yours and featured'),
  browsable(AUTO_ARTISTS, 'Artists'),
  browsable(AUTO_ALBUMS, 'Albums'),
];

/** Nodes that behave as track lists (tapping a track queues the list). */
const TRACK_LIST_NODES = new Set([AUTO_HOME, AUTO_RECENT, AUTO_LIKED]);

export class AndroidAutoContentProvider {
  /**
   * Playable tracks per track-list node, populated whenever children are
   * built. The controller reads this for queue building; misses force a
   * re-fetch so takedowns and deletions fail safe.
   */
  private readonly trackCache = new Map<string, TrackSummary[]>();
  /** Every item ever advertised, for onGetItem and play-context lookup. */
  private readonly advertised = new Map<string, AutoMediaItemPayload>();
  /** Which node each advertised track came from (queue context). */
  private readonly trackNode = new Map<string, string>();
  /** Recent voice-search results, keyed by query (queue context). */
  private readonly searchCache = new Map<string, TrackSummary[]>();

  constructor(private readonly api: ApiClient) {}

  /** Children for a Media3 parent id, paginated. Throws on unknown ids. */
  async getChildren(parentId: string, page: number, pageSize: number): Promise<AutoChildrenResult> {
    const parsed = parseAutoMediaId(parentId);
    if (parsed.kind === 'unknown') {
      throw new Error('Unknown Android Auto node');
    }
    const items =
      parsed.kind === 'node'
        ? await this.staticNodeChildren(parsed.id)
        : parsed.kind === 'track'
          ? this.trackChildren(parentId)
          : await this.parameterizedNodeChildren(parsed.kind, parsed.id);
    for (const item of items) {
      this.rememberAdvertised(item);
    }
    const start = Math.max(0, page) * Math.max(1, pageSize);
    return { ok: true, items: items.slice(start, start + Math.max(1, pageSize)) };
  }

  /** A single advertised item by media id; null when never advertised. */
  getAdvertisedItem(mediaId: string): AutoMediaItemPayload | null {
    return this.advertised.get(mediaId) ?? null;
  }

  /**
   * Register items built outside the node builders (voice-search results)
   * so onGetItem can answer them later without new network calls.
   */
  advertiseItems(items: AutoMediaItemPayload[]): void {
    for (const item of items) {
      this.rememberAdvertised(item);
    }
  }

  /** The node id a track was advertised from; null when unknown. */
  getTrackNodeId(trackId: string): string | null {
    return this.trackNode.get(trackId) ?? null;
  }

  /** Cached playable tracks for a node; null when never fetched. */
  getCachedTracks(nodeId: string): TrackSummary[] | null {
    return this.trackCache.get(nodeId) ?? null;
  }

  /** Playable tracks for a node, fetching on cache miss. */
  async getNodeTracks(nodeId: string): Promise<TrackSummary[]> {
    const cached = this.getCachedTracks(nodeId);
    if (cached) {
      return cached;
    }
    await this.getChildren(nodeId, 0, 200);
    return this.getCachedTracks(nodeId) ?? [];
  }

  /** Playable tracks for a node, always re-fetched (takedown safety net). */
  async refreshNodeTracks(nodeId: string): Promise<TrackSummary[]> {
    this.trackCache.delete(nodeId);
    return this.getNodeTracks(nodeId);
  }

  /** Remember voice-search results for queue context on tap. */
  rememberSearch(query: string, tracks: TrackSummary[]): void {
    if (this.searchCache.size > 20) {
      const oldest = this.searchCache.keys().next();
      if (!oldest.done) {
        this.searchCache.delete(oldest.value);
      }
    }
    this.searchCache.set(query, tracks);
  }

  /** Cached tracks for a search query; null when unknown. */
  getSearchTracks(query: string): TrackSummary[] | null {
    return this.searchCache.get(query) ?? null;
  }

  /** Cached search queries, newest-last, for play-context lookup. */
  getSearchQueries(): string[] {
    return [...this.searchCache.keys()];
  }

  private rememberAdvertised(item: AutoMediaItemPayload): void {
    if (this.advertised.size > 1000) {
      const oldest = this.advertised.keys().next();
      if (!oldest.done) {
        this.advertised.delete(oldest.value);
      }
    }
    this.advertised.set(item.mediaId, item);
  }

  private rememberTracks(nodeId: string, tracks: TrackSummary[]): void {
    if (TRACK_LIST_NODES.has(nodeId) || nodeId.includes(':')) {
      this.trackCache.set(nodeId, tracks);
      for (const t of tracks) {
        this.trackNode.set(t.id, nodeId);
      }
    }
  }

  // --- Node builders -------------------------------------------------------

  /**
   * A track id used as a browse parent (defensive — the car only browses
   * browsable ids): answer with the single advertised item so the host
   * never sees an error for a row it already rendered.
   */
  private trackChildren(mediaId: string): AutoMediaItemPayload[] {
    const item = this.advertised.get(mediaId);
    if (!item) {
      throw new Error('Unknown Android Auto node');
    }
    return [item];
  }

  private async staticNodeChildren(node: string): Promise<AutoMediaItemPayload[]> {
    switch (node) {
      case 'root':
        return ROOT_CHILDREN;
      case 'home':
        return this.homeChildren();
      case 'recent':
        return this.recentChildren();
      case 'liked':
        return this.likedChildren();
      case 'playlists':
        return this.playlistsChildren();
      case 'artists':
        return this.artistsChildren();
      case 'albums':
        return this.albumsChildren();
      default:
        throw new Error('Unknown Android Auto node');
    }
  }

  private async parameterizedNodeChildren(
    kind: 'album' | 'playlist' | 'artist',
    id: string,
  ): Promise<AutoMediaItemPayload[]> {
    switch (kind) {
      case 'album':
        return this.albumChildren(id);
      case 'playlist':
        return this.playlistChildren(id);
      case 'artist':
        return this.artistChildren(id);
    }
  }

  private async homeChildren(): Promise<AutoMediaItemPayload[]> {
    const [history, albums, playlists] = await Promise.all([
      listHistory(this.api, { limit: 10 }),
      listAlbums(this.api, { limit: 8 }),
      listPublicPlaylists(this.api, { limit: 8 }),
    ]);
    const recentTracks = dedupeReady(history.data.map((h) => h.track));
    this.rememberTracks(AUTO_HOME, recentTracks);
    const items: AutoMediaItemPayload[] = recentTracks.map(playableTrack);
    for (const a of albums.data) {
      items.push(browsable(albumMediaId(a.id), a.title, a.artistName));
    }
    for (const p of playlists.data) {
      items.push(browsable(playlistMediaId(p.id), p.title, `${p.trackCount} songs`));
    }
    if (items.length === 0) {
      return [
        messageItem(
          'waveform:msg:home-empty',
          'Nothing here yet',
          'Play something in the app first.',
        ),
      ];
    }
    return items;
  }

  private async recentChildren(): Promise<AutoMediaItemPayload[]> {
    const history = await listHistory(this.api, { limit: 50 });
    const tracks = dedupeReady(history.data.map((h) => h.track));
    this.rememberTracks(AUTO_RECENT, tracks);
    return tracks.length > 0
      ? tracks.map(playableTrack)
      : [messageItem('waveform:msg:recent-empty', 'Nothing played yet')];
  }

  private async likedChildren(): Promise<AutoMediaItemPayload[]> {
    const liked = await listLikedTracks(this.api, { limit: 50 });
    const tracks = dedupeReady(liked.data.map((l) => l.track));
    this.rememberTracks(AUTO_LIKED, tracks);
    return tracks.length > 0
      ? tracks.map(playableTrack)
      : [messageItem('waveform:msg:liked-empty', 'No liked songs yet', 'Like songs in the app.')];
  }

  private async playlistsChildren(): Promise<AutoMediaItemPayload[]> {
    const [mine, featured] = await Promise.all([
      listMyPlaylists(this.api, { limit: 25 }),
      listPublicPlaylists(this.api, { limit: 25 }),
    ]);
    const items: AutoMediaItemPayload[] = [];
    for (const p of mine.data) {
      items.push(browsable(playlistMediaId(p.id), p.title, `${p.trackCount} songs`));
    }
    for (const p of featured.data) {
      items.push(browsable(playlistMediaId(p.id), p.title, `${p.trackCount} songs`));
    }
    return items.length > 0
      ? items
      : [messageItem('waveform:msg:playlists-empty', 'No playlists yet', 'Create one in the app.')];
  }

  private async artistsChildren(): Promise<AutoMediaItemPayload[]> {
    const artists = await listArtists(this.api, { limit: 50 });
    return artists.data.length > 0
      ? artists.data.map((a) =>
          browsable(artistMediaId(a.id), a.name, a.verified ? 'Verified artist' : undefined),
        )
      : [messageItem('waveform:msg:artists-empty', 'No artists found')];
  }

  private async albumsChildren(): Promise<AutoMediaItemPayload[]> {
    const albums = await listAlbums(this.api, { limit: 50 });
    return albums.data.length > 0
      ? albums.data.map((a) => browsable(albumMediaId(a.id), a.title, a.artistName))
      : [messageItem('waveform:msg:albums-empty', 'No albums found')];
  }

  private async albumChildren(albumId: string): Promise<AutoMediaItemPayload[]> {
    // 404/403 propagate to the controller, which fails the browse — an
    // unpublished or missing album never renders.
    const album = await getAlbum(this.api, albumId);
    const nodeId = albumMediaId(albumId);
    const tracks = album.tracks
      .slice()
      .sort((a, b) => a.discNumber - b.discNumber || (a.trackNumber ?? 0) - (b.trackNumber ?? 0))
      .map((t) => albumTrackToSummary(album, t))
      .filter((t) => isReadyTrack(t.status));
    this.rememberTracks(nodeId, tracks);
    return tracks.length > 0
      ? tracks.map(playableTrack)
      : [messageItem('waveform:msg:album-empty', 'No playable tracks')];
  }

  private async playlistChildren(playlistId: string): Promise<AutoMediaItemPayload[]> {
    // Private playlists the user cannot see fail server-side (404) before
    // anything renders — the car never learns they exist.
    const playlist = await getPlaylist(this.api, playlistId);
    const nodeId = playlistMediaId(playlistId);
    const tracks = playlist.items
      .map((item) => playlistItemToSummary(item))
      .filter((t) => isReadyTrack(t.status));
    this.rememberTracks(nodeId, tracks);
    return tracks.length > 0
      ? tracks.map(playableTrack)
      : [messageItem('waveform:msg:playlist-empty', 'No playable tracks')];
  }

  private async artistChildren(artistId: string): Promise<AutoMediaItemPayload[]> {
    const [tracks, albums] = await Promise.all([
      listTracks(this.api, { artistId, limit: 25 }),
      listAlbums(this.api, { artistId, limit: 25 }),
    ]);
    const nodeId = artistMediaId(artistId);
    const playable = tracks.data.filter((t) => isReadyTrack(t.status));
    this.rememberTracks(nodeId, playable);
    const items: AutoMediaItemPayload[] = playable.map(playableTrack);
    for (const a of albums.data) {
      items.push(browsable(albumMediaId(a.id), a.title, undefined));
    }
    return items.length > 0
      ? items
      : [messageItem('waveform:msg:artist-empty', 'No playable tracks')];
  }
}
