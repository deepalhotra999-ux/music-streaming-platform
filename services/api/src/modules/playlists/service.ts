// Phase 4 — playlists. Domain logic: playlist CRUD, track management, and
// visibility rules. Throws HttpProblem errors (see http/errors.ts) which the
// central handler renders as RFC 7807.
//
// Visibility: PUBLIC playlists are readable by anyone (no auth); UNLISTED by
// any signed-in user (link knowledge assumed); PRIVATE only by the owner.
// Non-owners asking for a PRIVATE playlist — or any write they don't own —
// get 404 rather than 403, so playlist existence cannot be probed.

import type {
  PlaylistChangeAction,
  PlaylistVisibility,
  Prisma,
  PrismaClient,
  TrackStatus,
} from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, conflict, notFound, unauthorized } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';
import { toTrackSummary } from '../summaries.js';

type Db = PrismaClient;

interface TrackRow {
  id: string;
  title: string;
  durationMs: number;
  status: TrackStatus;
  artistId: string;
  albumId: string | null;
  deletedAt: Date | null;
  artist: { name: string };
  album: { title: string } | null;
}

interface PlaylistTrackRow {
  id: string;
  position: number;
  createdAt: Date;
  track: TrackRow;
}

interface PlaylistRowBase {
  id: string;
  title: string;
  description: string | null;
  coverArtUrl: string | null;
  visibility: PlaylistVisibility;
  ownerUserId: string;
  // Phase 27 — collaboration flag + optimistic-concurrency revision.
  isCollaborative: boolean;
  revision: number;
  owner: { displayName: string };
  createdAt: Date;
  updatedAt: Date;
  _count: { items: number };
}

interface PlaylistDetailRow extends PlaylistRowBase {
  items: PlaylistTrackRow[];
}

export interface PlaylistItemDto {
  id: string;
  position: number;
  addedAt: Date;
  track: ReturnType<typeof toTrackSummary>;
}

export interface PlaylistListDto {
  id: string;
  title: string;
  description: string | null;
  coverArtUrl: string | null;
  visibility: PlaylistVisibility;
  ownerUserId: string;
  ownerDisplayName: string;
  // Phase 27 — collaboration flag + optimistic-concurrency revision.
  isCollaborative: boolean;
  revision: number;
  trackCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ViewerRole = 'OWNER' | 'EDITOR' | null;

export interface PlaylistDetailDto extends PlaylistListDto {
  items: PlaylistItemDto[];
  /** Phase 27 — the viewer's collaboration role, null for non-members. */
  viewerRole: ViewerRole;
}

/** Artist/album names needed by toTrackSummary. */
const trackNames = {
  artist: { select: { name: true } },
  album: { select: { title: true } },
} as const;

const listInclude = {
  owner: { select: { displayName: true } },
  // trackCount skips items whose track was soft-deleted (defensive; track
  // deletion is blocked while the track sits in a playlist).
  _count: {
    select: { items: { where: { track: { deletedAt: null } } } },
  },
} as const;

const detailInclude = {
  ...listInclude,
  items: {
    orderBy: { position: 'asc' },
    include: { track: { include: trackNames } },
  },
} as const;

function toItemDto(row: PlaylistTrackRow): PlaylistItemDto {
  return {
    id: row.id,
    position: row.position,
    addedAt: row.createdAt,
    track: toTrackSummary(row.track),
  };
}

function toListDto(row: PlaylistRowBase): PlaylistListDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    coverArtUrl: row.coverArtUrl,
    visibility: row.visibility,
    ownerUserId: row.ownerUserId,
    ownerDisplayName: row.owner.displayName,
    isCollaborative: row.isCollaborative,
    revision: row.revision,
    trackCount: row._count.items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetailDto(row: PlaylistDetailRow, viewerRole: ViewerRole = null): PlaylistDetailDto {
  return {
    ...toListDto(row),
    items: row.items.filter((item) => !item.track.deletedAt).map(toItemDto),
    viewerRole,
  };
}

async function loadPlaylistRow(db: Db, id: string): Promise<PlaylistDetailRow> {
  const row = await db.playlist.findFirst({
    where: { id, deletedAt: null },
    include: detailInclude,
  });
  if (!row) {
    throw notFound('Playlist not found.');
  }
  return row;
}

/** Existence + ownership check for writes: non-owners get 404, never 403. */
async function loadOwnedPlaylist(db: Db, id: string, userId: string): Promise<PlaylistDetailRow> {
  const row = await loadPlaylistRow(db, id);
  if (row.ownerUserId !== userId) {
    throw notFound('Playlist not found.');
  }
  return row;
}

type Tx = Prisma.TransactionClient;

/**
 * Phase 27 — resolve the caller's collaboration role, if any. The playlist
 * owner is always OWNER; on collaborative playlists membership rows grant
 * EDITOR. Non-collaborative playlists have no editors.
 */
export async function getCollaboratorRole(
  db: Db | Tx,
  playlist: { id: string; ownerUserId: string; isCollaborative: boolean },
  userId: string,
): Promise<Exclude<ViewerRole, null> | null> {
  if (playlist.ownerUserId === userId) return 'OWNER';
  if (!playlist.isCollaborative) return null;
  const member = await db.playlistMember.findUnique({
    where: { playlistId_userId: { playlistId: playlist.id, userId } },
  });
  return member ? member.role : null;
}

/**
 * Phase 27 — optimistic-concurrency guard. Atomically bumps the playlist
 * revision only when it still matches the caller's expected revision and
 * returns the new revision. Stale writes get a 409 conflict, never a silent
 * overwrite.
 */
export async function bumpRevision(
  tx: Tx,
  playlistId: string,
  expectedRevision: number,
): Promise<number> {
  const updated = await tx.playlist.updateMany({
    where: { id: playlistId, revision: expectedRevision, deletedAt: null },
    data: { revision: { increment: 1 } },
  });
  if (updated.count === 0) {
    throw conflict('This playlist changed since you last loaded it. Reload and try again.');
  }
  return expectedRevision + 1;
}

/** Phase 27 — append one row to the append-only playlist change history. */
export async function recordChange(
  tx: Tx,
  playlistId: string,
  actorUserId: string,
  action: PlaylistChangeAction,
  revision: number,
  trackId?: string,
  itemId?: string,
): Promise<void> {
  await tx.playlistChange.create({
    data: {
      playlistId,
      actorUserId,
      action,
      revision,
      trackId: trackId ?? null,
      itemId: itemId ?? null,
    },
  });
}

export interface ListPublicPlaylistsQuery extends PaginationQuery {
  q?: string;
}

export async function listPublicPlaylists(
  query: ListPublicPlaylistsQuery,
  db: Db = prisma,
): Promise<PageEnvelope<PlaylistListDto>> {
  const p = parsePagination(query);
  const where = {
    deletedAt: null,
    visibility: 'PUBLIC' as PlaylistVisibility,
    ...(query.q ? { title: { contains: query.q, mode: 'insensitive' as const } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.playlist.findMany({
      where,
      include: listInclude,
      orderBy: { updatedAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.playlist.count({ where }),
  ]);
  return pageEnvelope(rows.map(toListDto), total, p);
}

export async function listMyPlaylists(
  userId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<PlaylistListDto>> {
  const p = parsePagination(query);
  // Phase 27 — "my playlists" includes playlists the caller owns AND
  // collaborative playlists they are a member of.
  const where = {
    deletedAt: null,
    OR: [{ ownerUserId: userId }, { members: { some: { userId } } }],
  };
  const [rows, total] = await Promise.all([
    db.playlist.findMany({
      where,
      include: listInclude,
      orderBy: { updatedAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.playlist.count({ where }),
  ]);
  return pageEnvelope(rows.map(toListDto), total, p);
}

export async function getPlaylistDetail(
  id: string,
  viewer: AuthUser | null,
  db: Db = prisma,
): Promise<PlaylistDetailDto> {
  const row = await loadPlaylistRow(db, id);
  // Phase 27 — resolve the viewer's collaboration role (null for anonymous
  // viewers and non-members). Members may read PRIVATE collaborative
  // playlists; everyone else keeps the existing visibility behavior.
  const viewerRole: ViewerRole = viewer ? await getCollaboratorRole(db, row, viewer.id) : null;
  if (row.visibility === 'PUBLIC') {
    return toDetailDto(row, viewerRole);
  }
  if (!viewer) {
    // UNLISTED requires a signed-in viewer; PRIVATE must not leak existence.
    if (row.visibility === 'UNLISTED') {
      throw unauthorized('Sign in to view this playlist.');
    }
    throw notFound('Playlist not found.');
  }
  if (row.visibility === 'PRIVATE' && !viewerRole) {
    throw notFound('Playlist not found.');
  }
  return toDetailDto(row, viewerRole);
}

export interface CreatePlaylistInput {
  title: string;
  description?: string | null;
  coverArtUrl?: string | null;
  visibility?: PlaylistVisibility;
}

export async function createPlaylist(
  userId: string,
  input: CreatePlaylistInput,
  db: Db = prisma,
): Promise<PlaylistDetailDto> {
  const row = await db.playlist.create({
    data: {
      title: input.title.trim(),
      description: input.description ?? null,
      coverArtUrl: input.coverArtUrl ?? null,
      visibility: input.visibility ?? 'PRIVATE',
      ownerUserId: userId,
    },
    include: detailInclude,
  });
  return toDetailDto(row);
}

export interface UpdatePlaylistInput {
  title?: string;
  description?: string | null;
  coverArtUrl?: string | null;
  visibility?: PlaylistVisibility;
}

export async function updatePlaylist(
  id: string,
  userId: string,
  input: UpdatePlaylistInput,
  db: Db = prisma,
): Promise<PlaylistDetailDto> {
  await loadOwnedPlaylist(db, id, userId);
  const data: {
    title?: string;
    description?: string | null;
    coverArtUrl?: string | null;
    visibility?: PlaylistVisibility;
  } = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.description !== undefined) data.description = input.description;
  if (input.coverArtUrl !== undefined) data.coverArtUrl = input.coverArtUrl;
  if (input.visibility !== undefined) data.visibility = input.visibility;
  const row = await db.playlist.update({ where: { id }, data, include: detailInclude });
  return toDetailDto(row);
}

export async function deletePlaylist(id: string, userId: string, db: Db = prisma): Promise<void> {
  await loadOwnedPlaylist(db, id, userId);
  await db.playlist.update({ where: { id }, data: { deletedAt: new Date() } });
}

export interface AddTrackInput {
  trackId: string;
  position?: number;
  /** Phase 27 — required on collaborative playlists for optimistic concurrency. */
  expectedRevision?: number;
}

export async function addTrackToPlaylist(
  playlistId: string,
  userId: string,
  input: AddTrackInput,
  db: Db = prisma,
): Promise<{ item: PlaylistItemDto; revision: number }> {
  const playlist = await loadPlaylistRow(db, playlistId);
  const role = await getCollaboratorRole(db, playlist, userId);
  if (!role) {
    // Non-members get 404, never 403: private playlist existence stays hidden.
    throw notFound('Playlist not found.');
  }
  const track = await db.track.findFirst({
    where: { id: input.trackId, deletedAt: null },
    include: trackNames,
  });
  if (!track) {
    throw notFound('Track not found.');
  }

  // Phase 27 — non-collaborative playlists keep the legacy owner-only path:
  // no revision check, no history row, identical behavior to before.
  if (!playlist.isCollaborative) {
    let position = input.position;
    if (position === undefined) {
      const agg = await db.playlistTrack.aggregate({
        where: { playlistId },
        _max: { position: true },
      });
      position = (agg._max.position ?? 0) + 1;
    }
    const item = await db.playlistTrack.create({
      data: {
        playlistId,
        trackId: track.id,
        position,
        addedByUserId: userId,
      },
      include: { track: { include: trackNames } },
    });
    return { item: toItemDto(item), revision: playlist.revision };
  }

  if (input.expectedRevision === undefined) {
    throw badRequest('expectedRevision is required for collaborative playlists.');
  }
  return prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlistId, input.expectedRevision!);
    let position = input.position;
    if (position === undefined) {
      const agg = await tx.playlistTrack.aggregate({
        where: { playlistId },
        _max: { position: true },
      });
      position = (agg._max.position ?? 0) + 1;
    }
    const item = await tx.playlistTrack.create({
      data: {
        playlistId,
        trackId: track.id,
        position,
        addedByUserId: userId,
      },
      include: { track: { include: trackNames } },
    });
    await recordChange(tx, playlistId, userId, 'TRACK_ADDED', revision, track.id, item.id);
    return { item: toItemDto(item), revision };
  });
}

export async function movePlaylistItem(
  playlistId: string,
  itemId: string,
  userId: string,
  position: number,
  expectedRevision?: number,
  db: Db = prisma,
): Promise<{ item: PlaylistItemDto; revision: number }> {
  const playlist = await loadPlaylistRow(db, playlistId);
  const role = await getCollaboratorRole(db, playlist, userId);
  if (!role) {
    throw notFound('Playlist not found.');
  }
  const item = await db.playlistTrack.findFirst({
    where: { id: itemId, playlistId },
    include: { track: { include: trackNames } },
  });
  if (!item) {
    throw notFound('Playlist item not found.');
  }

  if (!playlist.isCollaborative) {
    const updated = await db.playlistTrack.update({
      where: { id: item.id },
      data: { position },
      include: { track: { include: trackNames } },
    });
    return { item: toItemDto(updated), revision: playlist.revision };
  }

  if (expectedRevision === undefined) {
    throw badRequest('expectedRevision is required for collaborative playlists.');
  }
  return prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlistId, expectedRevision);
    const updated = await tx.playlistTrack.update({
      where: { id: item.id },
      data: { position },
      include: { track: { include: trackNames } },
    });
    await recordChange(tx, playlistId, userId, 'TRACK_MOVED', revision, item.trackId, item.id);
    return { item: toItemDto(updated), revision };
  });
}

export async function removePlaylistItem(
  playlistId: string,
  itemId: string,
  userId: string,
  expectedRevision?: number,
  db: Db = prisma,
): Promise<{ revision: number }> {
  const playlist = await loadPlaylistRow(db, playlistId);
  const role = await getCollaboratorRole(db, playlist, userId);
  if (!role) {
    throw notFound('Playlist not found.');
  }
  const item = await db.playlistTrack.findFirst({ where: { id: itemId, playlistId } });
  if (!item) {
    throw notFound('Playlist item not found.');
  }

  if (!playlist.isCollaborative) {
    await db.playlistTrack.delete({ where: { id: item.id } });
    return { revision: playlist.revision };
  }

  if (expectedRevision === undefined) {
    throw badRequest('expectedRevision is required for collaborative playlists.');
  }
  return prisma.$transaction(async (tx) => {
    const revision = await bumpRevision(tx, playlistId, expectedRevision);
    await tx.playlistTrack.delete({ where: { id: item.id } });
    await recordChange(tx, playlistId, userId, 'TRACK_REMOVED', revision, item.trackId, item.id);
    return { revision };
  });
}
