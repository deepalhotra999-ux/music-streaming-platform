-- Phase 25 — offline downloads & offline playback (corrected).
--
-- 1. tracks.audio_version: stable audio version identifier, pinned by
--    offline download authorizations; bumped on re-ingestion.
-- 2. offline_download_authorizations: server-minted download grants.
-- 3. playback_sessions: token_hash becomes nullable — synthetic sessions
--    created for offline playback carry no delivery token.
--    offline_session_key identifies the synthetic session for one offline
--    playback session (unique per user); NULL for online sessions.
-- 4. play_events: session_id stays NOT NULL. Offline events attach to the
--    synthetic session for their offlineSessionKey, so Phase 15 royalty /
--    session analytics keep working unchanged. createdAt is set from
--    occurredAt on insert so analytics bucket on actual playback time.

ALTER TABLE "tracks" ADD COLUMN "audio_version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "offline_download_authorizations" (
  "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "track_id" UUID NOT NULL,
  "audio_version" INTEGER NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "download_token_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "revoked_at" TIMESTAMPTZ(6),
  "last_validated_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "offline_download_authorizations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "offline_download_authorizations_track_id_fkey"
    FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "offline_download_authorizations_user_track_key"
  ON "offline_download_authorizations"("user_id", "track_id");
CREATE INDEX "offline_download_authorizations_user_expires_idx"
  ON "offline_download_authorizations"("user_id", "expires_at");
CREATE INDEX "offline_download_authorizations_expires_idx"
  ON "offline_download_authorizations"("expires_at");

-- Synthetic offline sessions: no delivery token, one per (user, session key).
-- The UNIQUE index treats NULL offline_session_key values as distinct, so
-- online sessions are unaffected.
ALTER TABLE "playback_sessions" ALTER COLUMN "token_hash" DROP NOT NULL;
ALTER TABLE "playback_sessions" ADD COLUMN "offline_session_key" TEXT;
CREATE UNIQUE INDEX "playback_sessions_user_offline_key"
  ON "playback_sessions"("user_id", "offline_session_key");

-- Offline events join the synthetic session; session_id stays NOT NULL.
ALTER TABLE "play_events" ADD COLUMN "offline_event_key" TEXT;
ALTER TABLE "play_events" ADD COLUMN "offline_authorization_id" UUID;
ALTER TABLE "play_events" ADD COLUMN "offline_session_key" TEXT;
ALTER TABLE "play_events" ADD COLUMN "occurred_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "play_events_offline_event_key_key"
  ON "play_events"("offline_event_key");
CREATE INDEX "play_events_offline_authorization_idx"
  ON "play_events"("offline_authorization_id");
CREATE INDEX "play_events_offline_session_idx"
  ON "play_events"("user_id", "offline_session_key");

ALTER TABLE "play_events"
  ADD CONSTRAINT "play_events_offline_authorization_id_fkey"
  FOREIGN KEY ("offline_authorization_id")
  REFERENCES "offline_download_authorizations"("id") ON DELETE SET NULL;
