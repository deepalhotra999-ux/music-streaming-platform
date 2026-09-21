-- Phase 7 — streaming infrastructure: playback sessions + play events.

-- CreateEnum
CREATE TYPE "PlayEventType" AS ENUM ('START', 'HEARTBEAT', 'COMPLETE', 'ERROR');

-- CreateTable
CREATE TABLE "playback_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "track_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playback_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "play_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "track_id" UUID NOT NULL,
    "event_type" "PlayEventType" NOT NULL,
    "position_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "play_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "playback_sessions_token_hash_key" ON "playback_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "playback_sessions_user_id_idx" ON "playback_sessions"("user_id");

-- CreateIndex
CREATE INDEX "playback_sessions_expires_at_idx" ON "playback_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "play_events_session_id_created_at_idx" ON "play_events"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "play_events_track_id_created_at_idx" ON "play_events"("track_id", "created_at");

-- AddForeignKey
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "play_events" ADD CONSTRAINT "play_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "playback_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "play_events" ADD CONSTRAINT "play_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
