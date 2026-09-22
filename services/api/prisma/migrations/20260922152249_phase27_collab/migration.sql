-- Phase 27 — collaborative playlists.
-- Opt-in collaboration: Playlist.is_collaborative + Playlist.revision for
-- optimistic concurrency, PlaylistMember (OWNER/EDITOR only),
-- PlaylistInvitation (hash-only tokens, expiring, revocable, single-use),
-- PlaylistChange (append-only history enforced by trigger below).

-- CreateEnum
CREATE TYPE "CollaboratorRole" AS ENUM ('OWNER', 'EDITOR');

-- CreateEnum
CREATE TYPE "PlaylistChangeAction" AS ENUM ('TRACK_ADDED', 'TRACK_REMOVED', 'TRACK_MOVED', 'COLLAB_ENABLED', 'COLLAB_DISABLED', 'MEMBER_ADDED', 'MEMBER_REMOVED', 'MEMBER_LEFT', 'INVITATION_CREATED', 'INVITATION_ACCEPTED', 'INVITATION_REVOKED');

-- AlterTable
ALTER TABLE "playlists" ADD COLUMN "is_collaborative" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "playlist_members" (
    "playlist_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "CollaboratorRole" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_members_pkey" PRIMARY KEY ("playlist_id","user_id")
);

-- CreateTable
CREATE TABLE "playlist_invitations" (
    "id" UUID NOT NULL,
    "playlist_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist_changes" (
    "id" UUID NOT NULL,
    "playlist_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" "PlaylistChangeAction" NOT NULL,
    "track_id" UUID,
    "item_id" UUID,
    "revision" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "playlist_members_user_id_idx" ON "playlist_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_invitations_token_hash_key" ON "playlist_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "playlist_invitations_playlist_id_idx" ON "playlist_invitations"("playlist_id");

-- CreateIndex
CREATE INDEX "playlist_invitations_expires_at_idx" ON "playlist_invitations"("expires_at");

-- CreateIndex
CREATE INDEX "playlist_changes_playlist_id_created_at_idx" ON "playlist_changes"("playlist_id", "created_at");

-- AddForeignKey
ALTER TABLE "playlist_members" ADD CONSTRAINT "playlist_members_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_members" ADD CONSTRAINT "playlist_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_invitations" ADD CONSTRAINT "playlist_invitations_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_invitations" ADD CONSTRAINT "playlist_invitations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_changes" ADD CONSTRAINT "playlist_changes_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_changes" ADD CONSTRAINT "playlist_changes_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only change history: reject UPDATE and DELETE on playlist_changes.
CREATE OR REPLACE FUNCTION "playlist_changes_no_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'playlist_changes is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "playlist_changes_no_mutation"
BEFORE UPDATE OR DELETE ON "playlist_changes"
FOR EACH ROW EXECUTE FUNCTION "playlist_changes_no_mutation"();
