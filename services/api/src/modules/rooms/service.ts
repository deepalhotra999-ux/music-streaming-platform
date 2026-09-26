// Phase 28 — synchronized listening rooms: room lifecycle, membership,
// invitations, authoritative state, and host commands.
//
// Design notes (ADR-022):
// - The server is authoritative for room state. Every host command advances
//   `revision` through an atomic compare-and-swap; stale commands get a
//   409-style `stale_revision` error and never land.
// - Rooms are private and invite-only. There is no discovery surface:
//   non-members get existence-hiding 404s everywhere (Phase 4/27 convention).
// - Joining or creating a room never grants playback entitlement. Every
//   participant mints their own Phase 7 playback sessions; the normal
//   subscription checks apply. Room state carries track IDs and display
//   metadata only — never playback tokens, never audio URLs.
// - Membership and host identity always come from the auth session, never
//   from client fields.
// - `positionMs` is authoritative at `stateAt` (server clock). Clients
//   extrapolate: expected = positionMs + (now - stateAt) while PLAYING.

import { randomBytes, createHash } from 'node:crypto';
import type { PrismaClient, RoomPlaybackState, RoomRole, RoomStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import {
  badRequest,
  conflict,
  forbidden,
  gone,
  notFound,
  subscriptionRequired,
} from '../../http/errors.js';
import { getEntitlement } from '../subscriptions/entitlements.js';

type Db = PrismaClient;
type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_QUEUE_TRACKS = 200;
const MAX_POSITION_MS = 24 * 60 * 60 * 1000; // 24h sanity bound

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface RoomTrackSummary {
  id: string;
  title: string;
  artistName: string;
  durationMs: number;
  artworkUrl: string | null;
}

export interface RoomStateDto {
  roomId: string;
  revision: number;
  status: RoomStatus;
  playbackState: RoomPlaybackState;
  currentTrackId: string | null;
  currentTrack: RoomTrackSummary | null;
  queueIndex: number;
  queue: RoomTrackSummary[];
  /** Authoritative position in ms, valid at `serverTime`. */
  positionMs: number;
  /** ISO-8601 server timestamp at which `positionMs` was authoritative. */
  serverTime: string;
  /** The requesting user's role in this room. */
  role: RoomRole;
}

export interface RoomMemberDto {
  userId: string;
  displayName: string;
  role: RoomRole;
  joinedAt: string;
}

export interface RoomInvitationDto {
  id: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateRoomInvitationResult extends RoomInvitationDto {
  /** Raw token, returned exactly once. Only the SHA-256 hash is stored. */
  token: string;
}

export type RoomCommand =
  | { type: 'play'; positionMs: number }
  | { type: 'pause'; positionMs: number }
  | { type: 'seek'; positionMs: number }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'queue'; trackIds: string[]; queueIndex?: number };

/** Room must exist. Non-members get 404 (no leak); status is checked by callers. */
async function loadRoom(db: Db | Tx, roomId: string) {
  const room = await db.listeningRoom.findUnique({ where: { id: roomId } });
  if (!room) {
    throw notFound('Room not found.');
  }
  return room;
}

/** Membership or existence-hiding 404. Returns the member row. */
async function requireMembership(db: Db | Tx, roomId: string, userId: string) {
  const member = await db.listeningRoomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });
  if (!member) {
    throw notFound('Room not found.');
  }
  return member;
}

/** Host-only guard. Call after requireMembership so non-members get 404. */
function requireHostRole(member: { role: RoomRole }) {
  if (member.role !== 'HOST') {
    throw forbidden('Only the host can perform this action.');
  }
}

/** Rooms are for listening: creating or joining requires playback entitlement. */
async function requirePlaybackEntitlement(db: Db, userId: string) {
  const entitlement = await getEntitlement(userId, db);
  if (!entitlement.entitled) {
    throw subscriptionRequired(
      `A subscription is required to join a listening room (${entitlement.reason}).`,
    );
  }
}

/** Every queue item must reference a streamable catalog track. */
async function requireStreamableTracks(db: Db | Tx, trackIds: string[]) {
  if (trackIds.length === 0) {
    throw badRequest('The queue must contain at least one track.');
  }
  if (trackIds.length > MAX_QUEUE_TRACKS) {
    throw badRequest(`The queue supports at most ${MAX_QUEUE_TRACKS} tracks.`);
  }
  const unique = [...new Set(trackIds)];
  const tracks = await db.track.findMany({
    where: { id: { in: unique }, deletedAt: null },
    select: { id: true, status: true },
  });
  const byId = new Map(tracks.map((t) => [t.id, t]));
  for (const id of unique) {
    const track = byId.get(id);
    if (!track) {
      throw notFound('Track not found.');
    }
    if (track.status !== 'READY') {
      throw conflict(`Track is not available for listening (status: ${track.status}).`);
    }
  }
}

function validatePositionMs(positionMs: unknown): number {
  if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) {
    throw badRequest('positionMs must be a number.');
  }
  const ms = Math.floor(positionMs);
  if (ms < 0 || ms > MAX_POSITION_MS) {
    throw badRequest('positionMs is out of range.');
  }
  return ms;
}

function toTrackSummary(track: {
  id: string;
  title: string;
  durationMs: number;
  artist: { name: string };
  album: { coverArtUrl: string | null } | null;
}): RoomTrackSummary {
  return {
    id: track.id,
    title: track.title,
    artistName: track.artist.name,
    durationMs: track.durationMs,
    artworkUrl: track.album?.coverArtUrl ?? null,
  };
}

const trackSummarySelect = {
  id: true,
  title: true,
  durationMs: true,
  artist: { select: { name: true } },
  album: { select: { coverArtUrl: true } },
} as const;

/** Build the authoritative state DTO. Caller must have established membership. */
export async function buildRoomState(
  db: Db | Tx,
  roomId: string,
  userId: string,
): Promise<RoomStateDto> {
  const room = await db.listeningRoom.findUnique({ where: { id: roomId } });
  if (!room) {
    throw notFound('Room not found.');
  }
  const member = await db.listeningRoomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });
  if (!member) {
    throw notFound('Room not found.');
  }
  const items = await db.listeningRoomQueueItem.findMany({
    where: { roomId },
    orderBy: { position: 'asc' },
    include: { track: { select: trackSummarySelect } },
  });
  const queue = items.map((i) => toTrackSummary(i.track));
  const currentItem = items.find((i) => i.trackId === room.currentTrackId);
  return {
    roomId: room.id,
    revision: room.revision,
    status: room.status,
    playbackState: room.playbackState,
    currentTrackId: room.currentTrackId,
    currentTrack: currentItem ? toTrackSummary(currentItem.track) : null,
    queueIndex: room.queueIndex,
    queue,
    positionMs: room.positionMs,
    serverTime: room.stateAt.toISOString(),
    role: member.role,
  };
}

/**
 * Resolve an initial queue: explicit track IDs, or a snapshot of a playlist
 * the caller can access. Playlist metadata never enters the room — only
 * validated track IDs — so private playlists cannot leak through rooms.
 */
async function resolveInitialQueue(
  db: Db | Tx,
  userId: string,
  input: { trackIds?: string[]; playlistId?: string },
): Promise<string[]> {
  if (input.playlistId && input.trackIds) {
    throw badRequest('Provide either trackIds or playlistId, not both.');
  }
  if (input.playlistId) {
    const playlist = await db.playlist.findFirst({
      where: { id: input.playlistId, deletedAt: null },
      include: {
        items: { orderBy: { position: 'asc' }, select: { trackId: true } },
      },
    });
    if (!playlist) {
      throw notFound('Playlist not found.');
    }
    // Access check mirrors Phase 4 visibility rules plus Phase 27 membership.
    const isOwner = playlist.ownerUserId === userId;
    const isMember = playlist.isCollaborative
      ? await db.playlistMember.findUnique({
          where: { playlistId_userId: { playlistId: playlist.id, userId } },
        })
      : null;
    if (playlist.visibility !== 'PUBLIC' && !isOwner && !isMember) {
      throw notFound('Playlist not found.');
    }
    const trackIds = playlist.items.map((i) => i.trackId);
    await requireStreamableTracks(db, trackIds);
    return trackIds;
  }
  if (!input.trackIds) {
    throw badRequest('Provide trackIds or playlistId to seed the room queue.');
  }
  await requireStreamableTracks(db, input.trackIds);
  return [...new Set(input.trackIds)];
}

export async function createRoom(
  userId: string,
  input: { trackIds?: string[]; playlistId?: string },
  db: Db = prisma,
): Promise<RoomStateDto> {
  await requirePlaybackEntitlement(db, userId);
  const trackIds = await resolveInitialQueue(db, userId, input);
  const now = new Date();
  const room = await db.$transaction(async (tx) => {
    const created = await tx.listeningRoom.create({
      data: {
        hostUserId: userId,
        status: 'ACTIVE',
        visibility: 'PRIVATE',
        revision: 0,
        playbackState: 'PAUSED',
        currentTrackId: trackIds[0],
        queueIndex: 0,
        positionMs: 0,
        stateAt: now,
        members: { create: { userId, role: 'HOST' } },
        queueItems: {
          create: trackIds.map((trackId, position) => ({
            trackId,
            position,
            addedByUserId: userId,
          })),
        },
      },
      select: { id: true },
    });
    return created;
  });
  return buildRoomState(db, room.id, userId);
}

export async function getRoomState(
  roomId: string,
  userId: string,
  db: Db = prisma,
): Promise<RoomStateDto> {
  await loadRoom(db, roomId);
  return buildRoomState(db, roomId, userId);
}

/**
 * Join via a single-use invitation token. The token is looked up by hash;
 * expired, revoked, or already-used invitations are rejected. Joining
 * requires playback entitlement and never grants any.
 */
export async function joinRoom(
  roomId: string,
  userId: string,
  token: string,
  db: Db = prisma,
): Promise<{ state: RoomStateDto; isNewMember: boolean }> {
  if (typeof token !== 'string' || token.length === 0) {
    throw badRequest('An invitation token is required.');
  }
  await requirePlaybackEntitlement(db, userId);
  const room = await loadRoom(db, roomId);
  if (room.status !== 'ACTIVE') {
    throw gone('This room has ended.');
  }
  // Already a member: idempotent rejoin, no token consumed.
  const existing = await db.listeningRoomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
  });
  if (existing) {
    return { state: await buildRoomState(db, roomId, userId), isNewMember: false };
  }
  const invitation = await db.listeningRoomInvitation.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  const now = new Date();
  if (
    !invitation ||
    invitation.roomId !== roomId ||
    invitation.revokedAt !== null ||
    invitation.usedAt !== null ||
    invitation.expiresAt.getTime() <= now.getTime()
  ) {
    // Indistinguishable: expired, revoked, used, wrong-room, and unknown
    // tokens all look the same so tokens cannot be probed.
    throw notFound('Room not found.');
  }
  await db.$transaction(async (tx) => {
    // Conditional claim: the update only lands when the invitation is still
    // unused, unrevoked, and unexpired, so exactly one concurrent joiner
    // wins the token. The losers see the same indistinguishable 404.
    const claimed = await tx.listeningRoomInvitation.updateMany({
      where: {
        id: invitation.id,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) {
      throw notFound('Room not found.');
    }
    try {
      await tx.listeningRoomMember.create({
        data: { roomId, userId, role: 'PARTICIPANT' },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Lost a race with a concurrent join for the same user (different
        // token). The token was legitimately consumed; the user is a member.
        return;
      }
      throw err;
    }
  });
  return { state: await buildRoomState(db, roomId, userId), isNewMember: true };
}

/**
 * Leave a room. Deterministic host-leaving policy: when the host leaves,
 * the room ends immediately for everyone — ownership is never silently
 * transferred. Memberships are preserved on end so members can still fetch
 * the authoritative ENDED state after a reconnect.
 */
export async function leaveRoom(
  roomId: string,
  userId: string,
  db: Db = prisma,
): Promise<{ ended: boolean }> {
  const room = await loadRoom(db, roomId);
  const member = await requireMembership(db, roomId, userId);
  if (room.status !== 'ACTIVE') {
    // Leaving an ended room just drops the caller's membership row.
    await db.listeningRoomMember.deleteMany({ where: { roomId, userId } });
    return { ended: true };
  }
  if (member.role === 'HOST') {
    await db.$transaction(async (tx) => {
      await tx.listeningRoom.update({
        where: { id: roomId },
        data: { status: 'ENDED', endedAt: new Date(), revision: { increment: 1 } },
      });
      await tx.listeningRoomInvitation.updateMany({
        where: { roomId, usedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    return { ended: true };
  }
  await db.listeningRoomMember.delete({
    where: { roomId_userId: { roomId, userId } },
  });
  return { ended: false };
}

/** Host ends the room without leaving first (same terminal semantics). */
export async function endRoom(roomId: string, userId: string, db: Db = prisma): Promise<void> {
  const room = await loadRoom(db, roomId);
  const member = await requireMembership(db, roomId, userId);
  requireHostRole(member);
  if (room.status !== 'ACTIVE') {
    return;
  }
  await db.$transaction(async (tx) => {
    await tx.listeningRoom.update({
      where: { id: roomId },
      data: { status: 'ENDED', endedAt: new Date(), revision: { increment: 1 } },
    });
    await tx.listeningRoomInvitation.updateMany({
      where: { roomId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });
}

export async function listRoomMembers(
  roomId: string,
  userId: string,
  db: Db = prisma,
): Promise<RoomMemberDto[]> {
  await loadRoom(db, roomId);
  await requireMembership(db, roomId, userId);
  const members = await db.listeningRoomMember.findMany({
    where: { roomId },
    include: { user: { select: { displayName: true } } },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  });
  return members.map((m) => ({
    userId: m.userId,
    displayName: m.user.displayName,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  }));
}

export async function createRoomInvitation(
  roomId: string,
  userId: string,
  db: Db = prisma,
): Promise<CreateRoomInvitationResult> {
  const room = await loadRoom(db, roomId);
  const member = await requireMembership(db, roomId, userId);
  requireHostRole(member);
  if (room.status !== 'ACTIVE') {
    throw gone('This room has ended.');
  }
  const token = randomBytes(32).toString('base64url');
  const invitation = await db.listeningRoomInvitation.create({
    data: {
      roomId,
      tokenHash: hashToken(token),
      createdByUserId: userId,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    },
  });
  return {
    id: invitation.id,
    token,
    expiresAt: invitation.expiresAt.toISOString(),
    usedAt: null,
    revokedAt: null,
    createdAt: invitation.createdAt.toISOString(),
  };
}

export async function listRoomInvitations(
  roomId: string,
  userId: string,
  db: Db = prisma,
): Promise<RoomInvitationDto[]> {
  await loadRoom(db, roomId);
  const member = await requireMembership(db, roomId, userId);
  requireHostRole(member);
  const invitations = await db.listeningRoomInvitation.findMany({
    where: { roomId },
    orderBy: { createdAt: 'desc' },
  });
  return invitations.map((i) => ({
    id: i.id,
    expiresAt: i.expiresAt.toISOString(),
    usedAt: i.usedAt?.toISOString() ?? null,
    revokedAt: i.revokedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(),
  }));
}

export async function revokeRoomInvitation(
  roomId: string,
  invitationId: string,
  userId: string,
  db: Db = prisma,
): Promise<void> {
  await loadRoom(db, roomId);
  const member = await requireMembership(db, roomId, userId);
  requireHostRole(member);
  const invitation = await db.listeningRoomInvitation.findFirst({
    where: { id: invitationId, roomId },
  });
  if (!invitation) {
    throw notFound('Invitation not found.');
  }
  if (invitation.usedAt !== null) {
    throw conflict('This invitation has already been used.');
  }
  await db.listeningRoomInvitation.update({
    where: { id: invitation.id },
    data: { revokedAt: new Date() },
  });
}

// --- Host commands ---------------------------------------------------------

/**
 * Apply a host command with optimistic concurrency. The revision bump is an
 * atomic compare-and-swap inside the mutation transaction: stale commands
 * (expectedRevision != current revision) get a 409 and never land.
 */
export async function applyRoomCommand(
  roomId: string,
  userId: string,
  command: RoomCommand,
  expectedRevision: number,
  db: Db = prisma,
): Promise<RoomStateDto> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw badRequest('expectedRevision must be a non-negative integer.');
  }
  const room = await loadRoom(db, roomId);
  if (room.status !== 'ACTIVE') {
    throw gone('This room has ended.');
  }
  const member = await requireMembership(db, roomId, userId);
  requireHostRole(member);

  const updated = await db.$transaction(async (tx) => {
    const current = await tx.listeningRoom.findUnique({ where: { id: roomId } });
    if (!current || current.status !== 'ACTIVE') {
      throw gone('This room has ended.');
    }
    if (current.revision !== expectedRevision) {
      throw conflict('Room state changed. Refresh and retry.');
    }
    const now = new Date();
    const items = await tx.listeningRoomQueueItem.findMany({
      where: { roomId },
      orderBy: { position: 'asc' },
      select: { trackId: true },
    });
    const trackIds = items.map((i) => i.trackId);

    let data: {
      playbackState?: RoomPlaybackState;
      currentTrackId?: string | null;
      queueIndex?: number;
      positionMs?: number;
      stateAt?: Date;
    };
    switch (command.type) {
      case 'play':
      case 'pause':
      case 'seek': {
        const positionMs = validatePositionMs(command.positionMs);
        data = {
          playbackState:
            command.type === 'play'
              ? 'PLAYING'
              : command.type === 'pause'
                ? 'PAUSED'
                : current.playbackState,
          positionMs,
          stateAt: now,
        };
        break;
      }
      case 'next':
      case 'previous': {
        const delta = command.type === 'next' ? 1 : -1;
        const nextIndex = current.queueIndex + delta;
        if (nextIndex < 0 || nextIndex >= trackIds.length) {
          // At the boundary: stop at the edge rather than wrapping.
          data = { positionMs: 0, stateAt: now, playbackState: 'PAUSED' };
        } else {
          const targetId = trackIds[nextIndex];
          await requireStreamableTracks(tx, [targetId]);
          data = {
            queueIndex: nextIndex,
            currentTrackId: targetId,
            positionMs: 0,
            stateAt: now,
          };
        }
        break;
      }
      case 'queue': {
        await requireStreamableTracks(tx, command.trackIds);
        const unique = [...new Set(command.trackIds)];
        const queueIndex = command.queueIndex ?? 0;
        if (!Number.isInteger(queueIndex) || queueIndex < 0 || queueIndex >= unique.length) {
          throw badRequest('queueIndex is out of range.');
        }
        await tx.listeningRoomQueueItem.deleteMany({ where: { roomId } });
        await tx.listeningRoomQueueItem.createMany({
          data: unique.map((trackId, position) => ({
            roomId,
            trackId,
            position,
            addedByUserId: userId,
          })),
        });
        data = {
          queueIndex,
          currentTrackId: unique[queueIndex],
          positionMs: 0,
          stateAt: now,
        };
        break;
      }
    }

    // Atomic compare-and-swap: only one concurrent writer can win.
    const result = await tx.listeningRoom.updateMany({
      where: { id: roomId, revision: expectedRevision },
      data: { ...data, revision: { increment: 1 }, updatedAt: now },
    });
    if (result.count === 0) {
      throw conflict('Room state changed. Refresh and retry.');
    }
    return tx.listeningRoom.findUnique({ where: { id: roomId } });
  });

  if (!updated) {
    throw notFound('Room not found.');
  }
  return buildRoomState(db, roomId, userId);
}
