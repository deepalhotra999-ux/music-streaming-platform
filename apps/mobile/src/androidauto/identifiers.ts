// Phase 24 — pure media-id helpers (JS mirror of AutoMediaIds.kt).
// No React Native imports: safe for unit tests.

export const AUTO_PREFIX = 'waveform:';

export const AUTO_ROOT = 'waveform:root';
export const AUTO_HOME = 'waveform:home';
export const AUTO_RECENT = 'waveform:recent';
export const AUTO_LIKED = 'waveform:liked';
export const AUTO_PLAYLISTS = 'waveform:playlists';
export const AUTO_ARTISTS = 'waveform:artists';
export const AUTO_ALBUMS = 'waveform:albums';

export type AutoMediaKind = 'track' | 'album' | 'playlist' | 'artist' | 'node' | 'unknown';

export interface ParsedAutoMediaId {
  kind: AutoMediaKind;
  /** Catalog id for track/album/playlist/artist; node key for static nodes. */
  id: string;
}

const STATIC_NODES = new Set([
  AUTO_ROOT,
  AUTO_HOME,
  AUTO_RECENT,
  AUTO_LIKED,
  AUTO_PLAYLISTS,
  AUTO_ARTISTS,
  AUTO_ALBUMS,
]);

export function trackMediaId(trackId: string): string {
  return `${AUTO_PREFIX}track:${trackId}`;
}
export function albumMediaId(albumId: string): string {
  return `${AUTO_PREFIX}album:${albumId}`;
}
export function playlistMediaId(playlistId: string): string {
  return `${AUTO_PREFIX}playlist:${playlistId}`;
}
export function artistMediaId(artistId: string): string {
  return `${AUTO_PREFIX}artist:${artistId}`;
}

/** Parse a media id minted by this app; unknown for anything else. */
export function parseAutoMediaId(mediaId: string | null | undefined): ParsedAutoMediaId {
  if (!mediaId || !mediaId.startsWith(AUTO_PREFIX)) {
    return { kind: 'unknown', id: '' };
  }
  if (STATIC_NODES.has(mediaId)) {
    return { kind: 'node', id: mediaId.slice(AUTO_PREFIX.length) };
  }
  const rest = mediaId.slice(AUTO_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) {
    return { kind: 'unknown', id: '' };
  }
  const kind = rest.slice(0, colon);
  const id = rest.slice(colon + 1);
  if (id.length === 0) {
    return { kind: 'unknown', id: '' };
  }
  switch (kind) {
    case 'track':
    case 'album':
    case 'playlist':
    case 'artist':
      return { kind, id };
    default:
      return { kind: 'unknown', id: '' };
  }
}

/** The catalog track id, or null when the media id is not our track. */
export function trackIdFromMediaId(mediaId: string | null | undefined): string | null {
  const parsed = parseAutoMediaId(mediaId);
  return parsed.kind === 'track' ? parsed.id : null;
}
