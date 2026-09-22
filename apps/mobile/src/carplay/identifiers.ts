// Phase 23 — pure bridge-id helpers (JS mirror of the Swift
// CarPlayIdentifiers). No React Native imports: safe for unit tests.

/** "track:<trackId>" — the item id native sends for a track selection. */
export function trackItemId(trackId: string): string {
  return `track:${trackId}`;
}

/** Extract the track id from a track item id; null for anything else. */
export function trackIdFromItemId(itemId: string): string | null {
  const prefix = 'track:';
  if (!itemId.startsWith(prefix)) {
    return null;
  }
  const id = itemId.slice(prefix.length);
  return id.length > 0 ? id : null;
}

export function albumNodeId(albumId: string): string {
  return `album:${albumId}`;
}
export function playlistNodeId(playlistId: string): string {
  return `playlist:${playlistId}`;
}
export function artistNodeId(artistId: string): string {
  return `artist:${artistId}`;
}

export interface SplitNodeId {
  base: string;
  parameter: string | null;
}

/** Split "album:<id>" into base/parameter; plain nodes have null parameter. */
export function splitNodeId(nodeId: string): SplitNodeId | null {
  const colon = nodeId.indexOf(':');
  if (colon >= 0) {
    const base = nodeId.slice(0, colon);
    const parameter = nodeId.slice(colon + 1);
    if (base.length === 0 || parameter.length === 0) {
      return null;
    }
    return { base, parameter };
  }
  return nodeId.length === 0 ? null : { base: nodeId, parameter: null };
}
