// Phase 15 — artist analytics & reporting. Query layer.
//
// All metrics derive server-side from the append-only play_events stream
// (Phase 7) joined to playback_sessions. The session is the unit of a
// "play", and its created_at is the canonical play timestamp used for
// date-range filtering. Every aggregation runs in SQL (window functions);
// raw events are never loaded into application memory.
//
// Metric definitions (see ADR-011; also reported in PHASE-15-REPORT.md):
// - stream:            a session with >= 1 COMPLETE event (counted once per
//                      session, however many COMPLETE rows it has)
// - start:             a session with >= 1 START event
// - failed play:       a session with >= 1 ERROR event and no COMPLETE
// - incomplete play:   a session with START but neither COMPLETE nor ERROR
// - unique listeners:  COUNT(DISTINCT user_id) over in-scope sessions
// - listening time:    per session, the sum over consecutive events
//                      (ordered by created_at, id) of
//                      clamp(positionMs[i] - positionMs[i-1], 0, 35000ms).
//                      Heartbeats only ever feed this sum — they can never
//                      create a stream. Duplicate heartbeats contribute 0.
//                      The 35s cap is the 30s heartbeat cadence plus jitter
//                      allowance; forward seeks are therefore approximated,
//                      backward seeks contribute nothing.
//
// Ownership isolation is structural, never client-driven: the track-id set
// is always derived server-side from the artist row (plus optional
// server-validated track/album filters), so a caller cannot smuggle in
// another artist's tracks through query params.

import type { PrismaClient } from '@prisma/client';
import type { AuthUser } from '../../http/auth.js';
import { canManageArtist } from '../../http/authorization.js';
import { forbidden, notFound } from '../../http/errors.js';
import {
  parsePagination,
  pageEnvelope,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

export type AnalyticsRange = '7d' | '28d' | '90d' | 'all';
export type TrendGranularity = 'day' | 'week';

const RANGE_DAYS: Record<Exclude<AnalyticsRange, 'all'>, number> = {
  '7d': 7,
  '28d': 28,
  '90d': 90,
};

/** Inclusive lower bound for a range, or null for all-time. */
export function rangeStart(range: AnalyticsRange, now: Date = new Date()): Date | null {
  if (range === 'all') return null;
  return new Date(now.getTime() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000);
}

export interface AnalyticsDeps {
  db: PrismaClient;
}

export interface TrackScope {
  trackIds: string[];
}

export interface OverviewTotals {
  streams: number;
  starts: number;
  failedPlays: number;
  incompletePlays: number;
  uniqueListeners: number;
  listeningTimeMs: number;
}

export interface OverviewDto extends OverviewTotals {
  artistId: string | null;
  range: AnalyticsRange;
  from: string | null;
  to: string;
}

export interface TrackStatsDto extends OverviewTotals {
  trackId: string;
  title: string;
}

export interface AlbumStatsDto extends OverviewTotals {
  albumId: string;
  title: string;
}

export interface TrendPointDto extends OverviewTotals {
  /** UTC bucket start: YYYY-MM-DD for day, Monday YYYY-MM-DD for week. */
  date: string;
}

export interface TrendDto {
  granularity: TrendGranularity;
  points: TrendPointDto[];
}

export interface RecentPlayDto {
  sessionId: string;
  trackId: string;
  trackTitle: string;
  playedAt: string;
  listeningTimeMs: number;
}

/**
 * Load the artist row and enforce the analytics audience: the owning
 * artist's user, or an admin. LISTENER callers never reach here with a
 * passing role check (routes require ARTIST/ADMIN), and cross-owner
 * artists fail here.
 */
async function requireAnalyticsArtist(
  db: PrismaClient,
  artistId: string,
  actor: AuthUser,
): Promise<{ id: string; ownerUserId: string | null }> {
  const artist = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    select: { id: true, ownerUserId: true },
  });
  if (!artist) throw notFound('Artist not found.');
  if (!canManageArtist(actor, artist)) {
    throw forbidden('You can only view analytics for artists you own.');
  }
  return artist;
}

/**
 * Resolve the server-side track scope for an artist: all of the artist's
 * non-deleted tracks, optionally narrowed by a track or album filter. The
 * filters are validated against the artist's own catalog — a trackId or
 * albumId that does not belong to the artist is a 404, never a silent
 * empty scope (which would hide authorization mistakes).
 */
async function resolveTrackScope(
  db: PrismaClient,
  artistId: string,
  filter: { trackId?: string; albumId?: string },
): Promise<TrackScope> {
  if (filter.trackId) {
    const track = await db.track.findFirst({
      where: { id: filter.trackId, artistId, deletedAt: null },
      select: { id: true },
    });
    if (!track) throw notFound('Track not found for this artist.');
    return { trackIds: [track.id] };
  }
  const tracks = await db.track.findMany({
    where: {
      artistId,
      deletedAt: null,
      ...(filter.albumId ? { albumId: filter.albumId } : {}),
    },
    select: { id: true },
  });
  if (filter.albumId) {
    const album = await db.album.findFirst({
      where: { id: filter.albumId, artistId, deletedAt: null },
      select: { id: true },
    });
    if (!album) throw notFound('Album not found for this artist.');
  }
  return { trackIds: tracks.map((t) => t.id) };
}

// --- SQL --------------------------------------------------------------------
// One shared per-session CTE powers every endpoint. `sessions` is the
// in-scope session set (track restriction + date-range lower bound);
// `session_stats` reduces each session to its outcome flags and its
// listening-time sum. All consumers aggregate session_stats further.

const SESSION_STATS_CTE = `
WITH sessions AS (
  SELECT s.id, s.user_id, s.track_id, s.created_at
  FROM playback_sessions s
  WHERE s.track_id = ANY($1::uuid[])
    AND ($2::timestamptz IS NULL OR s.created_at >= $2::timestamptz)
),
events AS (
  SELECT
    e.session_id,
    e.event_type,
    e.position_ms,
    LAG(e.position_ms) OVER (
      PARTITION BY e.session_id ORDER BY e.created_at, e.id
    ) AS prev_position_ms
  FROM play_events e
  WHERE e.session_id IN (SELECT id FROM sessions)
),
session_stats AS (
  SELECT
    sn.id,
    sn.user_id,
    sn.track_id,
    sn.created_at,
    MAX(CASE WHEN ev.event_type = 'START' THEN 1 ELSE 0 END)::int AS started,
    MAX(CASE WHEN ev.event_type = 'COMPLETE' THEN 1 ELSE 0 END)::int AS completed,
    MAX(CASE WHEN ev.event_type = 'ERROR' THEN 1 ELSE 0 END)::int AS errored,
    COALESCE(SUM(
      CASE
        WHEN ev.position_ms IS NOT NULL AND ev.prev_position_ms IS NOT NULL
        THEN LEAST(GREATEST(ev.position_ms - ev.prev_position_ms, 0), 35000)
        ELSE 0
      END
    ), 0)::bigint AS listened_ms
  FROM sessions sn
  LEFT JOIN events ev ON ev.session_id = sn.id
  GROUP BY sn.id, sn.user_id, sn.track_id, sn.created_at
)`;

const TOTALS_LIST = `
  COUNT(*) FILTER (WHERE completed = 1)::int AS streams,
  COUNT(*) FILTER (WHERE started = 1)::int AS starts,
  COUNT(*) FILTER (WHERE errored = 1 AND completed = 0)::int AS failed_plays,
  COUNT(*) FILTER (WHERE started = 1 AND completed = 0 AND errored = 0)::int AS incomplete_plays,
  COUNT(DISTINCT user_id)::int AS unique_listeners,
  COALESCE(SUM(listened_ms), 0)::bigint AS listening_time_ms`;

const TOTALS_SELECT = `SELECT ${TOTALS_LIST}`;

interface TotalsRow {
  streams: number;
  starts: number;
  failed_plays: number;
  incomplete_plays: number;
  unique_listeners: number;
  listening_time_ms: bigint;
}

function toTotals(row: TotalsRow): OverviewTotals {
  return {
    streams: Number(row.streams ?? 0),
    starts: Number(row.starts ?? 0),
    failedPlays: Number(row.failed_plays ?? 0),
    incompletePlays: Number(row.incomplete_plays ?? 0),
    uniqueListeners: Number(row.unique_listeners ?? 0),
    listeningTimeMs: Number(row.listening_time_ms ?? 0),
  };
}

function emptyTotals(): OverviewTotals {
  return {
    streams: 0,
    starts: 0,
    failedPlays: 0,
    incompletePlays: 0,
    uniqueListeners: 0,
    listeningTimeMs: 0,
  };
}

export interface OverviewQuery {
  range: AnalyticsRange;
  trackId?: string;
  albumId?: string;
}

export async function getArtistOverview(
  artistId: string,
  actor: AuthUser,
  query: OverviewQuery,
  deps: AnalyticsDeps,
): Promise<OverviewDto> {
  const { db } = deps;
  await requireAnalyticsArtist(db, artistId, actor);
  const scope = await resolveTrackScope(db, artistId, query);
  const now = new Date();
  const from = rangeStart(query.range, now);
  if (scope.trackIds.length === 0) {
    return {
      ...emptyTotals(),
      artistId,
      range: query.range,
      from: from?.toISOString() ?? null,
      to: now.toISOString(),
    };
  }
  const bound = await db.$queryRawUnsafe<TotalsRow[]>(
    `${SESSION_STATS_CTE} ${TOTALS_SELECT} FROM session_stats`,
    scope.trackIds,
    from,
  );
  return {
    ...toTotals(bound[0] ?? ({} as TotalsRow)),
    artistId,
    range: query.range,
    from: from?.toISOString() ?? null,
    to: now.toISOString(),
  };
}

export interface PagedQuery extends OverviewQuery, PaginationQuery {}

/** Per-track performance, ranked by streams desc. Only tracks with >= 1 session in range appear. */
export async function getArtistTrackStats(
  artistId: string,
  actor: AuthUser,
  query: PagedQuery,
  deps: AnalyticsDeps,
): Promise<PageEnvelope<TrackStatsDto>> {
  const { db } = deps;
  await requireAnalyticsArtist(db, artistId, actor);
  const scope = await resolveTrackScope(db, artistId, query);
  const p = parsePagination(query);
  const from = rangeStart(query.range);
  if (scope.trackIds.length === 0) return pageEnvelope([], 0, p);
  interface Row extends TotalsRow {
    track_id: string;
    title: string;
    total_count: number;
  }
  const rows = await db.$queryRawUnsafe<Row[]>(
    `${SESSION_STATS_CTE},
    per_track AS (
      SELECT
        st.track_id,
        ${TOTALS_LIST},
        COUNT(*) OVER ()::int AS total_count
      FROM session_stats st
      GROUP BY st.track_id
    )
    SELECT pt.*, t.title, pt.total_count
    FROM per_track pt
    JOIN tracks t ON t.id = pt.track_id
    ORDER BY pt.streams DESC, pt.listening_time_ms DESC, t.title ASC
    LIMIT $3 OFFSET $4`,
    scope.trackIds,
    from,
    p.limit,
    p.skip,
  );
  const total = rows[0]?.total_count ?? 0;
  const data: TrackStatsDto[] = rows.map((r) => ({
    ...toTotals(r),
    trackId: r.track_id,
    title: r.title,
  }));
  return pageEnvelope(data, total, p);
}

/** Per-album performance, ranked by streams desc. Only albums with >= 1 session in range appear. */
export async function getArtistAlbumStats(
  artistId: string,
  actor: AuthUser,
  query: PagedQuery,
  deps: AnalyticsDeps,
): Promise<PageEnvelope<AlbumStatsDto>> {
  const { db } = deps;
  await requireAnalyticsArtist(db, artistId, actor);
  const scope = await resolveTrackScope(db, artistId, query);
  const p = parsePagination(query);
  const from = rangeStart(query.range);
  if (scope.trackIds.length === 0) return pageEnvelope([], 0, p);
  interface Row extends TotalsRow {
    album_id: string;
    title: string;
    total_count: number;
  }
  const rows = await db.$queryRawUnsafe<Row[]>(
    `${SESSION_STATS_CTE},
    per_album AS (
      SELECT
        t.album_id,
        ${TOTALS_LIST},
        COUNT(*) OVER ()::int AS total_count
      FROM session_stats st
      JOIN tracks t ON t.id = st.track_id
      WHERE t.album_id IS NOT NULL
      GROUP BY t.album_id
    )
    SELECT pa.*, a.title, pa.total_count
    FROM per_album pa
    JOIN albums a ON a.id = pa.album_id
    ORDER BY pa.streams DESC, pa.listening_time_ms DESC, a.title ASC
    LIMIT $3 OFFSET $4`,
    scope.trackIds,
    from,
    p.limit,
    p.skip,
  );
  const total = rows[0]?.total_count ?? 0;
  const data: AlbumStatsDto[] = rows.map((r) => ({
    ...toTotals(r),
    albumId: r.album_id,
    title: r.title,
  }));
  return pageEnvelope(data, total, p);
}

/** Daily or weekly buckets over the range, ascending. Buckets are UTC. */
export async function getArtistTrend(
  artistId: string,
  actor: AuthUser,
  query: OverviewQuery & { granularity?: TrendGranularity },
  deps: AnalyticsDeps,
): Promise<TrendDto> {
  const { db } = deps;
  await requireAnalyticsArtist(db, artistId, actor);
  const scope = await resolveTrackScope(db, artistId, query);
  const granularity = query.granularity ?? 'day';
  const from = rangeStart(query.range);
  if (scope.trackIds.length === 0) return { granularity, points: [] };
  interface Row extends TotalsRow {
    bucket: Date;
  }
  const trunc = granularity === 'week' ? 'week' : 'day';
  const rows = await db.$queryRawUnsafe<Row[]>(
    `${SESSION_STATS_CTE}
    SELECT
      DATE_TRUNC('${trunc}', st.created_at AT TIME ZONE 'UTC')::date AS bucket,
      ${TOTALS_LIST}
    FROM session_stats st
    GROUP BY 1
    ORDER BY 1 ASC`,
    scope.trackIds,
    from,
  );
  return {
    granularity,
    points: rows.map((r) => ({
      ...toTotals(r),
      date: r.bucket.toISOString().slice(0, 10),
    })),
  };
}

/**
 * Latest completed streams. Deliberately exposes no listener identity —
 * just what played and when, which is all an artist needs for the
 * "recent activity" view.
 */
export async function getArtistRecentActivity(
  artistId: string,
  actor: AuthUser,
  query: OverviewQuery & { limit?: string },
  deps: AnalyticsDeps,
): Promise<RecentPlayDto[]> {
  const { db } = deps;
  await requireAnalyticsArtist(db, artistId, actor);
  const scope = await resolveTrackScope(db, artistId, query);
  const from = rangeStart(query.range);
  if (scope.trackIds.length === 0) return [];
  const rawLimit = query.limit === undefined ? 20 : Number.parseInt(query.limit, 10);
  const limit = Math.min(Math.max(rawLimit || 20, 1), 100);
  interface Row {
    session_id: string;
    track_id: string;
    title: string;
    played_at: Date;
    listened_ms: bigint;
  }
  const rows = await db.$queryRawUnsafe<Row[]>(
    `${SESSION_STATS_CTE}
    SELECT st.id AS session_id, st.track_id, t.title, st.created_at AS played_at, st.listened_ms
    FROM session_stats st
    JOIN tracks t ON t.id = st.track_id
    WHERE st.completed = 1
    ORDER BY st.created_at DESC, st.id DESC
    LIMIT $3`,
    scope.trackIds,
    from,
    limit,
  );
  return rows.map((r) => ({
    sessionId: r.session_id,
    trackId: r.track_id,
    trackTitle: r.title,
    playedAt: r.played_at.toISOString(),
    listeningTimeMs: Number(r.listened_ms ?? 0),
  }));
}

/** Platform-wide overview for ADMIN. Same metric definitions, no artist scoping. */
export async function getPlatformOverview(
  query: { range: AnalyticsRange },
  deps: AnalyticsDeps,
): Promise<OverviewDto> {
  const { db } = deps;
  const now = new Date();
  const from = rangeStart(query.range, now);
  const rows = await db.$queryRawUnsafe<TotalsRow[]>(
    `WITH sessions AS (
       SELECT s.id, s.user_id, s.track_id, s.created_at
       FROM playback_sessions s
       WHERE ($1::timestamptz IS NULL OR s.created_at >= $1::timestamptz)
     ),
     events AS (
       SELECT
         e.session_id,
         e.event_type,
         e.position_ms,
         LAG(e.position_ms) OVER (
           PARTITION BY e.session_id ORDER BY e.created_at, e.id
         ) AS prev_position_ms
       FROM play_events e
       WHERE e.created_at >= COALESCE($1::timestamptz, '-infinity'::timestamptz)
     ),
     session_stats AS (
       SELECT
         sn.id,
         sn.user_id,
         MAX(CASE WHEN ev.event_type = 'START' THEN 1 ELSE 0 END)::int AS started,
         MAX(CASE WHEN ev.event_type = 'COMPLETE' THEN 1 ELSE 0 END)::int AS completed,
         MAX(CASE WHEN ev.event_type = 'ERROR' THEN 1 ELSE 0 END)::int AS errored,
         COALESCE(SUM(
           CASE
             WHEN ev.position_ms IS NOT NULL AND ev.prev_position_ms IS NOT NULL
             THEN LEAST(GREATEST(ev.position_ms - ev.prev_position_ms, 0), 35000)
             ELSE 0
           END
         ), 0)::bigint AS listened_ms
       FROM sessions sn
       LEFT JOIN events ev ON ev.session_id = sn.id
       GROUP BY sn.id, sn.user_id
     )
     ${TOTALS_SELECT} FROM session_stats`,
    from,
  );
  return {
    ...toTotals(rows[0] ?? ({} as TotalsRow)),
    artistId: null,
    range: query.range,
    from: from?.toISOString() ?? null,
    to: now.toISOString(),
  };
}
