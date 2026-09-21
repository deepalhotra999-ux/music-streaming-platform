// Phase 4 — playlists. Domain logic: playlist CRUD, track management, and
// visibility rules. Throws HttpProblem errors (see http/errors.ts) which the
// central handler renders as RFC 7807.
//
// Visibility: PUBLIC playlists are readable by anyone (no auth); UNLISTED by
// any signed-in user (link knowledge assumed); PRIVATE only by the owner.
// Non-owners asking for a PRIVATE playlist — or any write they don't own —
// get 404 rather than 403, so playlist existence cannot be probed.

import type { PlaylistVisibility, PrismaClient, TrackStatus } from '@prisma/client';
import { prisma } from '../../db.js';
import { notFound, unauthorized } from '../../http/errors.js';
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
  trackCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaylistDetailDto extends PlaylistListDto {
  items: PlaylistItemDto[];
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
    trackCount: row._count.items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetailDto(row: PlaylistDetailRow): PlaylistDetailDto {
  return {
    ...toListDto(row),
    items: row.items.filter((item) => !item.track.deletedAt).map(toItemDto),
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
  const where = { deletedAt: null, ownerUserId: userId };
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
  if (row.visibility === 'PUBLIC') {
    return toDetailDto(row);
  }
  if (!viewer) {
    // UNLISTED requires a signed-in viewer; PRIVATE must not leak existence.
    if (row.visibility === 'UNLISTED') {
      throw unauthorized('Sign in to view this playlist.');
    }
    throw notFound('Playlist not found.');
  }
  if (row.visibility === 'PRIVATE' && row.ownerUserId !== viewer.id) {
    throw notFound('Playlist not found.');
  }
  return toDetailDto(row);
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
}

export async function addTrackToPlaylist(
  playlistId: string,
  userId: string,
  input: AddTrackInput,
  db: Db = prisma,
): Promise<PlaylistItemDto> {
  await loadOwnedPlaylist(db, playlistId, userId);
  const track = await db.track.findFirst({
    where: { id: input.trackId, deletedAt: null },
    include: trackNames,
  });
  if (!track) {
    throw notFound('Track not found.');
  }
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
  return toItemDto(item);
}

export async function movePlaylistItem(
  playlistId: string,
  itemId: string,
  userId: string,
  position: number,
  db: Db = prisma,
): Promise<PlaylistItemDto> {
  await loadOwnedPlaylist(db, playlistId, userId);
  const item = await db.playlistTrack.findFirst({
    where: { id: itemId, playlistId },
    include: { track: { include: trackNames } },
  });
  if (!item) {
    throw notFound('Playlist item not found.');
  }
  const updated = await db.playlistTrack.update({
    where: { id: item.id },
    data: { position },
    include: { track: { include: trackNames } },
  });
  return toItemDto(updated);
}

export async function removePlaylistItem(
  playlistId: string,
  itemId: string,
  userId: string,
  db: Db = prisma,
): Promise<void> {
  await loadOwnedPlaylist(db, playlistId, userId);
  const item = await db.playlistTrack.findFirst({ where: { id: itemId, playlistId } });
  if (!item) {
    throw notFound('Playlist item not found.');
  }
  await db.playlistTrack.delete({ where: { id: item.id } });
}
