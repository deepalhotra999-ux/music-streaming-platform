// Phase 21 — Royalty Engine. Eligible stream calculation.
//
// Reuses the Phase 15 (ADR-011) stream definition exactly: a stream is a
// playback session with >= 1 COMPLETE event, counted once per session
// however many COMPLETE rows it has. Sessions with ERROR and no COMPLETE
// (failed) or START with neither COMPLETE nor ERROR (incomplete) never
// count. The session's created_at is the canonical timestamp; a period
// includes sessions with periodStart <= created_at < periodEnd.
//
// Royalty-specific: the policy's minimum_streams threshold (if set)
// excludes tracks below the threshold from allocation. Excluded tracks
// get no earnings line; their streams do not enter the pool divisor.

import type { PrismaClient } from '@prisma/client';

export interface TrackStreamCount {
  trackId: string;
  artistId: string;
  streams: number;
}

export interface EligibleSession {
  sessionId: string;
  trackId: string;
  artistId: string;
  sessionCreatedAt: Date;
}

export interface EligibleStreamsResult {
  /** Per-track eligible stream counts, ordered by trackId (deterministic). */
  tracks: TrackStreamCount[];
  /** Total eligible streams across all tracks (post minimum filter). */
  totalStreams: number;
  /** Raw completed-session count before the minimum-streams filter. */
  rawCompletedSessions: number;
  /** Individual eligible sessions for the audit snapshot (post minimum filter). */
  sessions: EligibleSession[];
}

/**
 * Compute eligible streams for a period. Only sessions whose track belongs
 * to a non-deleted artist/track are counted (deleted catalog cannot earn).
 */
export async function getEligibleStreams(
  db: PrismaClient,
  periodStart: Date,
  periodEnd: Date,
  minimumStreams: number | null,
): Promise<EligibleStreamsResult> {
  interface Row {
    track_id: string;
    artist_id: string;
    streams: number;
  }
  interface SessionRow {
    session_id: string;
    track_id: string;
    artist_id: string;
    session_created_at: Date;
  }
  const rows = await db.$queryRawUnsafe<Row[]>(
    `WITH sessions AS (
       SELECT s.id, s.track_id, s.created_at
       FROM playback_sessions s
       WHERE s.created_at >= $1::timestamptz
         AND s.created_at < $2::timestamptz
     ),
     completed AS (
       SELECT DISTINCT e.session_id
       FROM play_events e
       WHERE e.session_id IN (SELECT id FROM sessions)
         AND e.event_type = 'COMPLETE'
     )
     SELECT s.track_id, t.artist_id, COUNT(DISTINCT c.session_id)::int AS streams
     FROM sessions s
     JOIN completed c ON c.session_id = s.id
     JOIN tracks t ON t.id = s.track_id
     JOIN artists a ON a.id = t.artist_id
     WHERE t.deleted_at IS NULL AND a.deleted_at IS NULL
     GROUP BY s.track_id, t.artist_id
     ORDER BY s.track_id ASC`,
    periodStart,
    periodEnd,
  );

  const rawCompletedSessions = rows.reduce((sum, r) => sum + r.streams, 0);
  const min = minimumStreams ?? 0;
  const eligibleTrackIds = new Set(rows.filter((r) => r.streams >= min).map((r) => r.track_id));
  const tracks: TrackStreamCount[] = rows
    .filter((r) => r.streams >= min)
    .map((r) => ({ trackId: r.track_id, artistId: r.artist_id, streams: r.streams }));
  const totalStreams = tracks.reduce((sum, t) => sum + t.streams, 0);

  // Individual sessions for the audit snapshot (only for tracks passing the filter).
  // Note: we fetch all completed sessions in the period and filter by track in
  // JS to avoid uuid[] array parameter binding issues.
  let sessions: EligibleSession[] = [];
  if (eligibleTrackIds.size > 0) {
    const sessionRows = await db.$queryRawUnsafe<SessionRow[]>(
      `WITH sessions AS (
         SELECT s.id AS session_id, s.track_id, t.artist_id, s.created_at AS session_created_at
         FROM playback_sessions s
         JOIN tracks t ON t.id = s.track_id
         JOIN artists a ON a.id = t.artist_id
         WHERE s.created_at >= $1::timestamptz
           AND s.created_at < $2::timestamptz
           AND t.deleted_at IS NULL AND a.deleted_at IS NULL
       ),
       completed AS (
         SELECT DISTINCT e.session_id
         FROM play_events e
         WHERE e.session_id IN (SELECT session_id FROM sessions)
           AND e.event_type = 'COMPLETE'
       )
       SELECT s.session_id, s.track_id, s.artist_id, s.session_created_at
       FROM sessions s
       JOIN completed c ON c.session_id = s.session_id
       ORDER BY s.session_id ASC`,
      periodStart,
      periodEnd,
    );
    sessions = sessionRows
      .filter((r) => eligibleTrackIds.has(r.track_id))
      .map((r) => ({
        sessionId: r.session_id,
        trackId: r.track_id,
        artistId: r.artist_id,
        sessionCreatedAt: r.session_created_at,
      }));
  }

  return { tracks, totalStreams, rawCompletedSessions, sessions };
}
