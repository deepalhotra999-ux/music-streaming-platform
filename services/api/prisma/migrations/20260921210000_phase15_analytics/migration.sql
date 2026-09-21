-- Phase 15 — artist analytics & reporting.
--
-- Analytics aggregates play_events per playback session (the session is the
-- unit of a "play"; its created_at is the canonical play timestamp). Two
-- indexes support the access patterns:
--
-- 1. playback_sessions(track_id, created_at): artist-scoped queries filter
--    sessions to the artist's own tracks inside a date range.
-- 2. play_events(created_at): the ADMIN platform-wide endpoint aggregates
--    without a track restriction, so it filters on event time only.
--
-- Existing indexes already cover the per-session event lookups
-- (play_events(session_id, created_at)) and per-track event lookups
-- (play_events(track_id, created_at)). No analytics tables are added:
-- everything is derived from the append-only event stream.

CREATE INDEX "playback_sessions_track_id_created_at_idx"
  ON "playback_sessions"("track_id", "created_at");

CREATE INDEX "play_events_created_at_idx"
  ON "play_events"("created_at");
