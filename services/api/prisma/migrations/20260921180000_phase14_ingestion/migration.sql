-- Phase 14 — artist audio upload & processing pipeline.
-- Per-track ingestion lifecycle, independent of the catalog TrackStatus so
-- re-processing a published track never unpublishes it: the previous HLS
-- package keeps serving until the new one validates, and a failed re-upload
-- leaves the catalog status untouched.

CREATE TYPE "AudioIngestStatus" AS ENUM ('NONE', 'PENDING', 'PROCESSING', 'READY', 'FAILED');

ALTER TABLE "tracks" ADD COLUMN "audio_status" "AudioIngestStatus" NOT NULL DEFAULT 'NONE';
ALTER TABLE "tracks" ADD COLUMN "audio_error" TEXT;
ALTER TABLE "tracks" ADD COLUMN "audio_source_key" TEXT;
ALTER TABLE "tracks" ADD COLUMN "audio_ready_at" TIMESTAMPTZ(6);

-- Tracks already READY have valid HLS packages (Phase 7 dev audio), so they
-- accurately report READY. Everything else starts at NONE (no source uploaded).
UPDATE "tracks" SET "audio_status" = 'READY', "audio_ready_at" = NOW() WHERE "status" = 'READY';
