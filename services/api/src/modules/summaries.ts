// Phase 4 — summary shapes shared across catalog and library modules.
// Full detail schemas live in each module; these compact shapes are embedded
// in playlist items, likes, follows, and history entries.

export const artistSummarySchema = {
  type: 'object',
  required: ['id', 'name', 'verified'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    verified: { type: 'boolean' },
  },
} as const;

export const trackSummarySchema = {
  type: 'object',
  required: ['id', 'title', 'durationMs', 'status', 'artistId', 'artistName'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    durationMs: { type: 'integer' },
    status: { type: 'string' },
    artistId: { type: 'string', format: 'uuid' },
    artistName: { type: 'string' },
    albumId: { type: ['string', 'null'], format: 'uuid' },
    albumTitle: { type: ['string', 'null'] },
  },
} as const;

interface ArtistRow {
  id: string;
  name: string;
  verified: boolean;
}

export function toArtistSummary(artist: ArtistRow): {
  id: string;
  name: string;
  verified: boolean;
} {
  return { id: artist.id, name: artist.name, verified: artist.verified };
}

interface TrackSummaryRow {
  id: string;
  title: string;
  durationMs: number;
  status: string;
  artistId: string;
  artist: { name: string };
  albumId: string | null;
  album: { title: string } | null;
}

export function toTrackSummary(track: TrackSummaryRow): {
  id: string;
  title: string;
  durationMs: number;
  status: string;
  artistId: string;
  artistName: string;
  albumId: string | null;
  albumTitle: string | null;
} {
  return {
    id: track.id,
    title: track.title,
    durationMs: track.durationMs,
    status: track.status,
    artistId: track.artistId,
    artistName: track.artist.name,
    albumId: track.albumId,
    albumTitle: track.album?.title ?? null,
  };
}
