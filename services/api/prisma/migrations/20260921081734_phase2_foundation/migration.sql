-- Required for the CITEXT email columns below. (Added 2026-09-21: the original
-- migration assumed the extension already existed in the target database.)
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('LISTENER', 'ARTIST', 'ADMIN');

-- CreateEnum
CREATE TYPE "AlbumType" AS ENUM ('ALBUM', 'SINGLE', 'EP', 'COMPILATION');

-- CreateEnum
CREATE TYPE "TrackStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED', 'TAKEDOWN');

-- CreateEnum
CREATE TYPE "PlaylistVisibility" AS ENUM ('PRIVATE', 'PUBLIC', 'UNLISTED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "auth_subject" TEXT,
    "email" CITEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'LISTENER',
    "country_code" CHAR(2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artists" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "owner_user_id" UUID,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "artists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artist_profiles" (
    "id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "bio" TEXT,
    "image_url" TEXT,
    "banner_url" TEXT,
    "website" TEXT,
    "social_links" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "artist_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "albums" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "artist_id" UUID NOT NULL,
    "album_type" "AlbumType" NOT NULL DEFAULT 'ALBUM',
    "release_date" DATE,
    "cover_art_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "albums_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracks" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "artist_id" UUID NOT NULL,
    "album_id" UUID,
    "duration_ms" INTEGER NOT NULL,
    "track_number" INTEGER,
    "disc_number" INTEGER NOT NULL DEFAULT 1,
    "isrc" TEXT,
    "status" "TrackStatus" NOT NULL DEFAULT 'PROCESSING',
    "play_count" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "genres" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "genres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "track_genres" (
    "track_id" UUID NOT NULL,
    "genre_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "track_genres_pkey" PRIMARY KEY ("track_id","genre_id")
);

-- CreateTable
CREATE TABLE "playlists" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "cover_art_url" TEXT,
    "visibility" "PlaylistVisibility" NOT NULL DEFAULT 'PRIVATE',
    "owner_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "playlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist_tracks" (
    "id" UUID NOT NULL,
    "playlist_id" UUID NOT NULL,
    "track_id" UUID NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "likes" (
    "user_id" UUID NOT NULL,
    "track_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "likes_pkey" PRIMARY KEY ("user_id","track_id")
);

-- CreateTable
CREATE TABLE "follows" (
    "user_id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("user_id","artist_id")
);

-- CreateTable
CREATE TABLE "listening_history" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "track_id" UUID NOT NULL,
    "played_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "progress_ms" INTEGER,
    "completed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "listening_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "store" TEXT,
    "store_subscription_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_subject_key" ON "users"("auth_subject");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "artists_owner_user_id_idx" ON "artists"("owner_user_id");

-- CreateIndex
CREATE INDEX "artists_name_idx" ON "artists"("name");

-- CreateIndex
CREATE UNIQUE INDEX "artist_profiles_artist_id_key" ON "artist_profiles"("artist_id");

-- CreateIndex
CREATE INDEX "albums_artist_id_release_date_idx" ON "albums"("artist_id", "release_date");

-- CreateIndex
CREATE UNIQUE INDEX "tracks_isrc_key" ON "tracks"("isrc");

-- CreateIndex
CREATE INDEX "tracks_artist_id_idx" ON "tracks"("artist_id");

-- CreateIndex
CREATE INDEX "tracks_album_id_track_number_idx" ON "tracks"("album_id", "track_number");

-- CreateIndex
CREATE INDEX "tracks_status_idx" ON "tracks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "genres_name_key" ON "genres"("name");

-- CreateIndex
CREATE INDEX "playlists_owner_user_id_updated_at_idx" ON "playlists"("owner_user_id", "updated_at");

-- CreateIndex
CREATE INDEX "playlist_tracks_playlist_id_position_idx" ON "playlist_tracks"("playlist_id", "position");

-- CreateIndex
CREATE INDEX "listening_history_user_id_played_at_idx" ON "listening_history"("user_id", "played_at");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_store_store_subscription_id_idx" ON "subscriptions"("store", "store_subscription_id");

-- AddForeignKey
ALTER TABLE "artists" ADD CONSTRAINT "artists_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artist_profiles" ADD CONSTRAINT "artist_profiles_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "albums" ADD CONSTRAINT "albums_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_genres" ADD CONSTRAINT "track_genres_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "track_genres" ADD CONSTRAINT "track_genres_genre_id_fkey" FOREIGN KEY ("genre_id") REFERENCES "genres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_added_by_user_id_fkey" FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_history" ADD CONSTRAINT "listening_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listening_history" ADD CONSTRAINT "listening_history_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
