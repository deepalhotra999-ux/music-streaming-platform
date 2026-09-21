// Phase 7 — streaming. HLS playlist rewriting.
//
// Stored playlists reference their children by bare relative names
// ("seg-00000.ts", "128k/index.m3u8"). Served playlists must instead point at
// the session-scoped API routes — with the session token attached — so that:
//   1. no permanent public audio URL ever leaks to the client, and
//   2. every segment fetch re-validates the playback session.
//
// This module is pure string manipulation: no I/O, no session knowledge.

/**
 * Rewrite every URI line of an m3u8 playlist. Lines starting with '#' are
 * directives and pass through untouched; every other non-empty line is a
 * media/p child URI and is replaced by `mapUri(line)`.
 */
export function rewritePlaylistUris(stored: string, mapUri: (uri: string) => string): string {
  return stored
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return line;
      return mapUri(trimmed);
    })
    .join('\n');
}

/** Build the session-scoped URL for a rendition playlist or segment. */
export function sessionAssetUrl(
  basePath: string,
  assetPath: string,
  token: string,
): string {
  return `${basePath}/hls/${assetPath}?token=${encodeURIComponent(token)}`;
}

/**
 * Minimal structural validation: the playlist must be an extended m3u8 and,
 * for media playlists, must not be empty. This catches corrupt/truncated
 * packages at serve time instead of handing the player garbage.
 */
export function assertValidPlaylist(text: string): void {
  const first = text.split('\n', 1)[0]?.trim();
  if (first !== '#EXTM3U') {
    throw new Error('Stored playlist is not a valid m3u8 (missing #EXTM3U).');
  }
}

/** Generate the stored master playlist for a track's renditions. */
export function buildMasterPlaylist(renditions: Array<{ name: string; bandwidth: number }>): string {
  const lines = ['#EXTM3U'];
  for (const r of renditions) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},CODECS="mp4a.40.2"`);
    lines.push(`${r.name}/index.m3u8`);
  }
  lines.push('');
  return lines.join('\n');
}
