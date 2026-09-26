-- Phase 28 — synchronized listening rooms.
-- This migration contains ONLY Phase 28 objects: 4 enums, 4 tables,
-- 7 indexes, and 9 foreign keys. (An earlier generated draft also carried
-- Prisma shadow-comparison noise — drop/re-add of pre-existing FKs,
-- defaults, and index renames from earlier phases — which was removed.)

-- CreateEnum
CREATE TYPE "RoomRole" AS ENUM ('HOST', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "RoomPlaybackState" AS ENUM ('PLAYING', 'PAUSED');

-- CreateEnum
CREATE TYPE "RoomVisibility" AS ENUM ('PRIVATE');

-- CreateTable
CREATE TABLE "listening_rooms" (
    "id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "status" "RoomStatus" NOT NULL DEFAULT 'ACTIVE',
    "visibility" "RoomVisibility" NOT NULL DEFAULT 'PRIVATE',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "playback_state" "RoomPlaybackState" NOT NULL DEFAULT 'PAUSED',
    "current_track_id" UUID,
    "queue_index" INTEGER NOT NULL DEFAULT 0,
    "position_ms" INTEGER NOT NULL DEFAULT 0,
    "state_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),

    CONSTRAINT "listening_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listening_room_queue_items" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "track_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listening_room_queue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listening_room_members" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "RoomRole" NOT NULL,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listening_room_members_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateTable
CREATE TABLE "listening_room_invitations" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listening_room_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listening_rooms_host_user_id_idx" ON "listening_rooms"("host_user_id");

-- CreateIndex
CREATE INDEX "listening_rooms_status_idx" ON "listening_rooms"("status");

-- CreateIndex
CREATE INDEX "listening_room_queue_items_room_id_position_idx" ON "listening_room_queue_items"("room_id", "position");

-- CreateIndex
CREATE INDEX "listening_room_members_user_id_idx" ON "listening_room_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "listening_room_invitations_token_hash_key" ON "listening_room_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "listening_room_invitations_room_id_idx" ON "listening_room_invitations"("room_id");

-- CreateIndex
CREATE INDEX "listening_room_invitations_expires_at_idx" ON "listening_room_invitations"("expires_at");

-- AddForeignKey
ALTER TABLE "listening_rooms" ADD CONSTRAINT "listening_rooms_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_rooms" ADD CONSTRAINT "listening_rooms_current_track_id_fkey" FOREIGN KEY ("current_track_id") REFERENCES "tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_room_queue_items" ADD CONSTRAINT "listening_room_queue_items_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "listening_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_room_queue_items" ADD CONSTRAINT "listening_room_queue_items_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_room_queue_items" ADD CONSTRAINT "listening_room_queue_items_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_room_members" ADD CONSTRAINT "listening_room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "listening_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_room_members" ADD CONSTRAINT "listening_room_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_room_invitations" ADD CONSTRAINT "listening_room_invitations_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "listening_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_room_invitations" ADD CONSTRAINT "listening_room_invitations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
