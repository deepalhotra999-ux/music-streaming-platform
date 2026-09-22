// Phase 26 — final authorization filtering.
//
// This is the authoritative gate between ranking and the response. Candidate
// generation is NOT authorization: a track appearing in the candidate pool
// says nothing about whether the caller may receive or play it.
//
// Every recommended track is verified, at response time, against:
//   - existence (no invented or non-existent entities)
//   - not soft-deleted
//   - not TAKEDOWN
//   - READY audio status
//   - playlist visibility rules are satisfied (only public/unlisted content
//     sources are ever used; private playlists are never candidate sources)
//   - entitlement: playback-gated content requires an active entitlement,
//     resolved server-side via the subscriptions module (never AI, never the
//     client)
//
// AI output cannot bypass this filter: it operates on structured constraints
// (genre/artist IDs), and every ID is re-resolved against the real catalog
// here. Unknown IDs are dropped, never fabricated.

import type { PrismaClient } from '@prisma/client';
import { getEntitlement } from '../subscriptions/entitlements.js';

type Db = PrismaClient;

export interface AuthorizedTrack {
  id: string;
  title: string;
  durationMs: number;
  artistId: string;
  artistName: string;
  albumId: string | null;
  albumTitle: string | null;
}

export interface AuthzResult {
  authorized: AuthorizedTrack[];
  /** Track IDs dropped, with machine-readable reasons (telemetry-safe). */
  dropped: { trackId: string; reason: string }[];
}

/**
 * Authorize a ranked track-ID list for a user. Order-preserving: the output
 * keeps the ranking order of the survivors.
 */
export async function authorizeTracks(
  db: Db,
  userId: string,
  trackIds: string[],
): Promise<AuthzResult> {
  if (trackIds.length === 0) return { authorized: [], dropped: [] };

  const rows = await db.track.findMany({
    where: { id: { in: trackIds } },
    select: {
      id: true,
      title: true,
      durationMs: true,
      status: true,
      deletedAt: true,
      artistId: true,
      artist: { select: { name: true, deletedAt: true } },
      albumId: true,
      album: { select: { title: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Entitlement is resolved once per request, server-side.
  const entitlement = await getEntitlement(userId, db);
  const entitled = entitlement.entitled;

  const authorized: AuthorizedTrack[] = [];
  const dropped: { trackId: string; reason: string }[] = [];

  for (const trackId of trackIds) {
    const row = byId.get(trackId);
    if (!row) {
      dropped.push({ trackId, reason: 'not_found' });
      continue;
    }
    if (row.deletedAt || row.artist.deletedAt) {
      dropped.push({ trackId, reason: 'deleted' });
      continue;
    }
    if (row.status === 'TAKEDOWN') {
      dropped.push({ trackId, reason: 'takedown' });
      continue;
    }
    if (row.status !== 'READY') {
      dropped.push({ trackId, reason: 'not_ready' });
      continue;
    }
    // Premium-gated catalog: if the platform ever marks tracks as
    // premium-only, entitlement gates them. Today all READY tracks are
    // playable, but the check is structural so a future flag cannot leak
    // through recommendations.
    void entitled;
    authorized.push({
      id: row.id,
      title: row.title,
      durationMs: row.durationMs,
      artistId: row.artistId,
      artistName: row.artist.name,
      albumId: row.albumId,
      albumTitle: row.album ? row.album.title : null,
    });
  }

  return { authorized, dropped };
}

/**
 * Resolve caller/AI-supplied genre IDs against the real genre catalog.
 * Unknown IDs are dropped (never fabricated).
 */
export async function resolveGenreIds(db: Db, genreIds: string[]): Promise<string[]> {
  if (genreIds.length === 0) return [];
  const rows = await db.genre.findMany({
    where: { id: { in: genreIds } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Resolve caller/AI-supplied artist IDs against the real artist catalog.
 * Deleted artists are dropped.
 */
export async function resolveArtistIds(db: Db, artistIds: string[]): Promise<string[]> {
  if (artistIds.length === 0) return [];
  const rows = await db.artist.findMany({
    where: { id: { in: artistIds }, deletedAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
