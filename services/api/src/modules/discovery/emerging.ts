// Phase 26 — emerging-artist discovery.
//
// "Emerging" is defined by transparent, measurable criteria — never by
// subjective AI judgment. The EmergingArtistPolicy (see policies.ts) fixes:
//   - maxAgeDays:          artist created within this window (newness)
//   - growthWindowDays:    recent-vs-previous stream comparison window
//   - minGrowthRatio:      recent/previous stream ratio to qualify (growth)
//   - minStreams/maxStreams: eligible-stream volume range in the window
//   - maxHistoricalStreams: cap on lifetime exposure (limited history)
//
// Streams here reuse Phase 15 semantics: one COMPLETE play event per
// playback session = one stream. We count from play_events (the same source
// royalty analytics uses), never from listening_history, so the definition
// stays consistent with the platform's canonical stream unit.

import { Prisma, type PrismaClient } from '@prisma/client';
import type { EmergingArtistPolicy } from './policies.js';

type Db = PrismaClient;

export interface EmergingArtist {
  artistId: string;
  artistName: string;
  recentStreams: number;
  previousStreams: number;
  growthRatio: number;
}

/**
 * Find emerging artists per the configured policy.
 *
 * Two windowed COUNT queries over play_events (indexed by createdAt), joined
 * against artists created within maxAgeDays. Results are capped; this is a
 * bounded aggregation, not a full-table scan per request (callers cache the
 * artist list briefly via the discovery cache).
 */
export async function findEmergingArtists(
  db: Db,
  policy: EmergingArtistPolicy,
  now: Date = new Date(),
  limit = 25,
): Promise<EmergingArtist[]> {
  const windowMs = policy.growthWindowDays * 24 * 60 * 60 * 1000;
  const recentStart = new Date(now.getTime() - windowMs);
  const previousStart = new Date(now.getTime() - 2 * windowMs);
  const newestAllowed = new Date(now.getTime() - policy.maxAgeDays * 24 * 60 * 60 * 1000);

  // NOTE: Prisma's groupBy cannot traverse relations, so the artist-level
  // aggregation below uses targeted raw SQL instead.
  type Row = {
    artist_id: string;
    artist_name: string;
    streams: bigint;
  };
  const recentRows = await db.$queryRaw<Row[]>`
    SELECT a.id AS artist_id, a.name AS artist_name,
           COUNT(DISTINCT pe.session_id)::bigint AS streams
    FROM play_events pe
    JOIN tracks t ON t.id = pe.track_id
    JOIN artists a ON a.id = t.artist_id
    WHERE pe.event_type = 'COMPLETE'
      AND pe.created_at >= ${recentStart}
      AND a.created_at >= ${newestAllowed}
      AND a.deleted_at IS NULL
    GROUP BY a.id, a.name
  `;
  const previousRows = await db.$queryRaw<Row[]>`
    SELECT a.id AS artist_id, COUNT(DISTINCT pe.session_id)::bigint AS streams
    FROM play_events pe
    JOIN tracks t ON t.id = pe.track_id
    JOIN artists a ON a.id = t.artist_id
    WHERE pe.event_type = 'COMPLETE'
      AND pe.created_at >= ${previousStart}
      AND pe.created_at < ${recentStart}
      AND a.created_at >= ${newestAllowed}
      AND a.deleted_at IS NULL
    GROUP BY a.id
  `;

  const previousByArtist = new Map<string, number>();
  for (const r of previousRows) {
    previousByArtist.set(r.artist_id, Number(r.streams));
  }

  const emerging: EmergingArtist[] = [];
  for (const r of recentRows) {
    const recentStreams = Number(r.streams);
    if (recentStreams < policy.minStreams || recentStreams > policy.maxStreams) {
      continue;
    }
    const previousStreams = previousByArtist.get(r.artist_id) ?? 0;
    // Avoid divide-by-zero: an artist with no previous-window streams and
    // enough recent streams qualifies on newness alone.
    const growthRatio =
      previousStreams === 0 ? Number.POSITIVE_INFINITY : recentStreams / previousStreams;
    if (previousStreams > 0 && growthRatio < policy.minGrowthRatio) continue;
    emerging.push({
      artistId: r.artist_id,
      artistName: r.artist_name,
      recentStreams,
      previousStreams,
      growthRatio,
    });
  }

  // Historical-exposure cap: exclude artists whose lifetime streams exceed
  // the limit, even if they grew recently. Artist IDs are composed with
  // Prisma.join so each ID becomes its own uuid-typed parameter (never a
  // single comma-joined text blob, which PostgreSQL cannot compare to uuid).
  if (emerging.length > 0) {
    const ids = Prisma.join(emerging.map((e) => Prisma.sql`${e.artistId}::uuid`));
    const lifetime = await db.$queryRaw<{ artist_id: string; streams: bigint }[]>(Prisma.sql`
      SELECT a.id AS artist_id, COUNT(DISTINCT pe.session_id)::bigint AS streams
      FROM play_events pe
      JOIN tracks t ON t.id = pe.track_id
      JOIN artists a ON a.id = t.artist_id
      WHERE pe.event_type = 'COMPLETE'
        AND a.id IN (${ids})
      GROUP BY a.id
    `);
    const lifetimeByArtist = new Map(
      lifetime.map((r) => [r.artist_id, Number(r.streams)] as const),
    );
    return emerging
      .filter((e) => (lifetimeByArtist.get(e.artistId) ?? 0) <= policy.maxHistoricalStreams)
      .sort((a, b) => b.recentStreams - a.recentStreams)
      .slice(0, limit);
  }
  return [];
}

/** READY track IDs for a set of emerging artists (bounded). */
export async function emergingTrackIds(
  db: Db,
  artistIds: string[],
  perArtist = 3,
): Promise<string[]> {
  if (artistIds.length === 0) return [];
  const tracks = await db.track.findMany({
    where: { status: 'READY', deletedAt: null, artistId: { in: artistIds } },
    orderBy: { playCount: 'desc' },
    take: artistIds.length * perArtist,
    select: { id: true },
  });
  return tracks.map((t) => t.id);
}
