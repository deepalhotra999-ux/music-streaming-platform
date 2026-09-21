# 011. Artist analytics over the playback event stream

Date: 2026-09-21
Status: accepted

## Context

Phase 15 gives ARTIST users reporting over their own catalog: headline
totals, a streams trend, top tracks/albums, and recent completed plays.
The raw material is the Phase 7 `play_events` append-only stream
(`START` / `HEARTBEAT` / `COMPLETE` / `ERROR` with `position_ms`) plus
`playback_sessions`. Requirements that shaped the design:

- Aggregates must be computed server-side from the event stream; the
  client must never be trusted with counts (the engine already reports
  raw events only).
- Analytics must be structurally isolated to the artist's own catalog;
  LISTENER/USER roles must get nothing.
- No new database, warehouse, or real-time infrastructure in this phase
  (explicit brief constraint).
- Metric semantics (what counts as a stream, a listener, listening time)
  must be defined precisely, and event-model limitations documented
  rather than papered over.

## Decision

1. **Playback session as the unit of a play.** `playback_sessions.created_at`
   is the canonical timestamp for date-range filtering and trend buckets
   (events inherit their session's date; a session's events can straddle
   midnight but the play counts once, on the day it started). Range lower
   bounds are inclusive; `all` has no lower bound. Trend buckets are UTC
   day / UTC week.

2. **Stream = session with ≥ 1 COMPLETE.** Duplicate COMPLETE events
   still count one stream (`COUNT(DISTINCT session_id)` over sessions
   having a COMPLETE). START-only sessions are starts, not streams.
   Sessions with ERROR and no COMPLETE are failed plays; sessions with
   START, no COMPLETE, no ERROR are incomplete plays. Neither ever counts
   as a stream.

3. **Unique listeners = distinct session `userId`** over all in-scope
   sessions (not only completed streams) — the audience that attempted
   playback, which is the more honest reach number for an artist.

4. **Listening time = sum of clamped consecutive position deltas.**
   Per session, order events by `(created_at, id)` and sum
   `clamp(current.position_ms − previous.position_ms, 0, 35_000)` ms.
   Duplicate heartbeats contribute 0, backward seeks contribute 0, and
   large forward jumps are capped at 35s (one heartbeat interval + 5s
   tolerance). This is a deterministic *approximation*, documented as
   such: forward seeks can still contribute up to the cap, missing events
   understate time, and positions do not prove uninterrupted listening.
   Heartbeats alone never create a stream.

5. **Aggregation in PostgreSQL, not in application memory.** One query
   per endpoint section using CTEs + window functions over
   `playback_sessions` joined to `play_events`; raw events are never
   materialized into Node. Two covering indexes were added
   (`playback_sessions(track_id, created_at)`,
   `play_events(created_at)`); no new tables.

6. **Authorization.** Artist endpoints require ARTIST/ADMIN, then
   `canManageArtist` ownership validation; track/album filter ids are
   validated against that artist's catalog (foreign ids → 404, never an
   empty-looking success). LISTENER → 403. Recent activity exposes
   track/session/time only — no listener identity. A single
   ADMIN-only platform overview endpoint exists where the existing
   authorization model permits.

7. **Mobile reads, never computes.** The app holds typed wrappers and
   formatting only; every number on screen is server-computed. The
   Analytics screen lives in the existing `(artist)` ARTIST-only stack
   with loading / no-artist / no-plays / error / retry states.

## Consequences

- Royalty-grade exactness is explicitly out of scope: listening time is
  an approximation and the report documents the event-model limits.
- The `35_000` ms cap and heartbeat cadence (30s) are coupled; if the
  engine's cadence ever changes, the cap must move with it.
- Trend bucketing is UTC; per-timezone bucketing is a future phase.
- No materialized rollups: at very large event volumes these queries
  will need pre-aggregation (a future phase may add it without changing
  the API contract).
