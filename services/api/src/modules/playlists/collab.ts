// Phase 27 — collaborative playlists: settings, membership, invitations,
// and change history. Domain logic throws HttpProblem errors (see
// http/errors.ts) which the central handler renders as RFC 7807.
//
// Design notes (ADR-021):
// - Collaboration is opt-in per playlist; roles are OWNER (the playlist
//   owner) and EDITOR (invited members). The owner always controls settings
//   and membership; editors may add/remove/reorder tracks.
// - Invitations are single-use, expiring, revocable bearer tokens. Only a
//   SHA-256 hash of the token is stored; the raw token is shown once at
//   creation and never persisted or logged.
// - Optimistic concurrency: collaborative track mutations require the
//   caller's expectedRevision; stale writes get a 409 conflict.
// - playlist_changes is append-only (DB trigger rejects UPDATE/DELETE).
// - No email/push/notification system: invitation tokens are returned to
//   the owner to share out-of-band.

import { randomBytes, createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import {
  bumpRevision,
  getCollaboratorRole,
  recordChange,
  type PlaylistDetailDto,
  type ViewerRole,
} from './service.js';

type Db = PrismaClient;
type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface PlaylistMemberDto {
  userId: string;
  displayName: string;
  role: 'OWNER' | 'EDITOR';
  joinedAt: string;
}

export interface PlaylistInvitationDto {
  id: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface PlaylistChangeDto {
  id: string;
  actorUserId: string;
  actorDisplayName: string;
  action: string;
  trackId: string | null;
  itemId: string | null;
  revision: number;
  createdAt: string;
}

/** Load the playlist row or 404 (never leaks existence to non-members). */
async function loadPlaylistForCollab(db: Db | Tx, playlistId: string) {
  const playlist = await db.playlist.findFirst({
    where: { id: playlistId, deletedAt: null },
  });
  if (!playlist) {
    throw notFound('Playlist not found.');
  }
  return playlist;
}

/** Owner-only guard. Non-owners get 404 so private playlists stay hidden. */
async function requireOwner(
  db: Db | Tx,
  playlist: { id: string; ownerUserId: string; isCollaborative: boolean },
  userId: string,
) {
  const role = await getCollaboratorRole(db, playlist, userId);
  if (role !== 'OWNER') {
    throw notFound('Playlist not found.');
  }
}

/** Any member (owner or editor) guard. */
async function requireMember(
  db: Db | Tx,
  playlist: { id: string; ownerUserId: string; isCollaborative: boolean },
  userId: string,
): Promise<Exclude<ViewerRole, null>> {
  const role = await getCollaboratorRole(db, playlist, userId);
  if (!role) {
    throw notFound('Playlist not found.');
  }
  return role;
}

/**
 * Enable or disable collaboration. Owner only. Disabling clears memberships
 * and revokes outstanding invitations so editors lose access immediately.
 */
export async function setCollaborative(
  playlistId: string,
  userId: string,
  enabled: boolean,
  db: Db = prisma,
): Promise<{ isCollaborative: boolean; revision: number }> {
  const playlist = await loadPlaylistForCollab(db, playlistId);
  await requireOwner(db, playlist, userId);
  if (playlist.isCollaborative === enabled) {
    return { isCollaborative: enabled, revision: playlist.revision };
  }
  return prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlistId, playlist.revision);
    const updated = await tx.playlist.update({
      where: { id: playlistId },
      data: { isCollaborative: enabled },
    });
    if (!enabled) {
      await tx.playlistMember.deleteMany({ where: { playlistId } });
      await tx.playlistInvitation.updateMany({
        where: { playlistId, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    await recordChange(
      tx,
      playlistId,
      userId,
      enabled ? 'COLLAB_ENABLED' : 'COLLAB_DISABLED',
      revision,
    );
    return { isCollaborative: updated.isCollaborative, revision };
  });
}

/** List members. Members only; non-members get 404. */
export async function listMembers(
  playlistId: string,
  userId: string,
  db: Db = prisma,
): Promise<PlaylistMemberDto[]> {
  const playlist = await loadPlaylistForCollab(db, playlistId);
  await requireMember(db, playlist, userId);
  const [owner, members] = await Promise.all([
    db.user.findUnique({ where: { id: playlist.ownerUserId } }),
    db.playlistMember.findMany({
      where: { playlistId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const out: PlaylistMemberDto[] = [];
  if (owner) {
    out.push({
      userId: owner.id,
      displayName: owner.displayName,
      role: 'OWNER',
      joinedAt: playlist.createdAt.toISOString(),
    });
  }
  for (const m of members) {
    out.push({
      userId: m.userId,
      displayName: m.user.displayName,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    });
  }
  return out;
}

/**
 * Create an invitation. Owner only. Returns the raw token exactly once —
 * it is never stored, only its SHA-256 hash.
 */
export async function createInvitation(
  playlistId: string,
  userId: string,
  db: Db = prisma,
): Promise<{ token: string; invitation: PlaylistInvitationDto }> {
  const playlist = await loadPlaylistForCollab(db, playlistId);
  await requireOwner(db, playlist, userId);
  if (!playlist.isCollaborative) {
    throw badRequest('Enable collaboration before creating invitations.');
  }
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const row = await prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlistId, playlist.revision);
    const invitation = await tx.playlistInvitation.create({
      data: {
        playlistId,
        tokenHash: hashToken(token),
        expiresAt,
        createdByUserId: userId,
      },
    });
    await recordChange(tx, playlistId, userId, 'INVITATION_CREATED', revision);
    return invitation;
  });
  return {
    token,
    invitation: {
      id: row.id,
      expiresAt: row.expiresAt.toISOString(),
      usedAt: null,
      revokedAt: null,
      createdByUserId: row.createdByUserId,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

/** List invitations (including used/revoked). Owner only. */
export async function listInvitations(
  playlistId: string,
  userId: string,
  db: Db = prisma,
): Promise<PlaylistInvitationDto[]> {
  const playlist = await loadPlaylistForCollab(db, playlistId);
  await requireOwner(db, playlist, userId);
  const rows = await db.playlistInvitation.findMany({
    where: { playlistId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt ? row.usedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Revoke an invitation. Owner only. Already-used invitations cannot be revoked. */
export async function revokeInvitation(
  playlistId: string,
  invitationId: string,
  userId: string,
  db: Db = prisma,
): Promise<void> {
  const playlist = await loadPlaylistForCollab(db, playlistId);
  await requireOwner(db, playlist, userId);
  const invitation = await db.playlistInvitation.findFirst({
    where: { id: invitationId, playlistId },
  });
  if (!invitation) {
    throw notFound('Invitation not found.');
  }
  if (invitation.usedAt) {
    throw conflict('Invitation has already been used.');
  }
  if (invitation.revokedAt) {
    return; // idempotent
  }
  await prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlistId, playlist.revision);
    await tx.playlistInvitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() },
    });
    await recordChange(tx, playlistId, userId, 'INVITATION_REVOKED', revision);
  });
}

/**
 * Accept an invitation token. The caller is derived from auth — the token
 * alone grants nothing without a signed-in user, and the userId in the
 * membership row always comes from the session.
 */
export async function acceptInvitation(
  token: string,
  user: AuthUser,
  db: Db = prisma,
): Promise<PlaylistDetailDto> {
  const tokenHash = hashToken(token);
  const invitation = await db.playlistInvitation.findUnique({
    where: { tokenHash },
    include: { playlist: true },
  });
  if (!invitation || invitation.playlist.deletedAt) {
    throw notFound('Invitation not found.');
  }
  if (invitation.revokedAt) {
    throw forbidden('This invitation has been revoked.');
  }
  if (invitation.usedAt) {
    throw conflict('This invitation has already been used.');
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    throw forbidden('This invitation has expired.');
  }
  const playlist = invitation.playlist;
  if (!playlist.isCollaborative) {
    throw conflict('This playlist is no longer collaborative.');
  }
  if (playlist.ownerUserId === user.id) {
    throw badRequest('You already own this playlist.');
  }
  const existing = await db.playlistMember.findUnique({
    where: { playlistId_userId: { playlistId: playlist.id, userId: user.id } },
  });
  if (existing) {
    throw conflict('You are already a member of this playlist.');
  }
  const { getPlaylistDetail } = await import('./service.js');
  await prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlist.id, playlist.revision);
    await tx.playlistInvitation.update({
      where: { id: invitation.id },
      data: { usedAt: new Date() },
    });
    await tx.playlistMember.create({
      data: { playlistId: playlist.id, userId: user.id, role: 'EDITOR' },
    });
    await recordChange(tx, playlist.id, user.id, 'INVITATION_ACCEPTED', revision);
    await recordChange(tx, playlist.id, user.id, 'MEMBER_ADDED', revision);
  });
  return getPlaylistDetail(playlist.id, user, db);
}

/** Leave a collaborative playlist. Editors only; owners cannot leave. */
export async function leavePlaylist(
  playlistId: string,
  userId: string,
  db: Db = prisma,
): Promise<void> {
  const playlist = await loadPlaylistForCollab(db, playlistId);
  const role = await requireMember(db, playlist, userId);
  if (role === 'OWNER') {
    throw badRequest('Playlist owners cannot leave; delete the playlist instead.');
  }
  await prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlistId, playlist.revision);
    await tx.playlistMember.delete({
      where: { playlistId_userId: { playlistId, userId } },
    });
    await recordChange(tx, playlistId, userId, 'MEMBER_LEFT', revision);
  });
}

/** Remove a member. Owner only; the owner can never be removed. */
export async function removeMember(
  playlistId: string,
  memberUserId: string,
  userId: string,
  db: Db = prisma,
): Promise<void> {
  const playlist = await loadPlaylistForCollab(db, playlistId);
  await requireOwner(db, playlist, userId);
  if (memberUserId === playlist.ownerUserId) {
    throw badRequest('The playlist owner cannot be removed.');
  }
  const member = await db.playlistMember.findUnique({
    where: { playlistId_userId: { playlistId, userId: memberUserId } },
  });
  if (!member) {
    throw notFound('Member not found.');
  }
  await prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlistId, playlist.revision);
    await tx.playlistMember.delete({
      where: { playlistId_userId: { playlistId, userId: memberUserId } },
    });
    await recordChange(tx, playlistId, userId, 'MEMBER_REMOVED', revision);
  });
}

/** List change history. Members only; non-members get 404. */
export async function listChanges(
  playlistId: string,
  userId: string,
  limit: number,
  db: Db = prisma,
): Promise<PlaylistChangeDto[]> {
  const playlist = await loadPlaylistForCollab(db, playlistId);
  await requireMember(db, playlist, userId);
  const rows = await db.playlistChange.findMany({
    where: { playlistId },
    include: { actor: true },
    orderBy: [{ revision: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Math.max(limit, 1), 100),
  });
  return rows.map((row) => ({
    id: row.id,
    actorUserId: row.actorUserId,
    actorDisplayName: row.actor.displayName,
    action: row.action,
    trackId: row.trackId,
    itemId: row.itemId,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  }));
}

// Re-export helpers for routes/tests that need role checks.
export { getCollaboratorRole };
