// Phase 4 — albums. Domain logic: public catalog reads plus owner/admin
// management of an artist's albums. Throws HttpProblem errors (see
// http/errors.ts) which the central handler renders as RFC 7807.

import { Prisma, type PrismaClient, type AlbumType } from '@prisma/client';
import { prisma } from '../../db.js';
import { conflict, forbidden, notFound } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import { canManageArtist } from '../../http/authorization.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

type Db = PrismaClient;

interface AlbumListRow {
  id: string;
  title: string;
  artistId: string;
  artist: { name: string };
  albumType: AlbumType;
  releaseDate: Date | null;
  coverArtUrl: string | null;
  createdAt: Date;
  _count: { tracks: number };
}

export interface AlbumListItemDto {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  albumType: AlbumType;
  releaseDate: Date | null;
  coverArtUrl: string | null;
  trackCount: number;
  createdAt: Date;
}

function toListItem(row: AlbumListRow): AlbumListItemDto {
  return {
    id: row.id,
    title: row.title,
    artistId: row.artistId,
    artistName: row.artist.name,
    albumType: row.albumType,
    releaseDate: row.releaseDate,
    coverArtUrl: row.coverArtUrl,
    trackCount: row._count.tracks,
    createdAt: row.createdAt,
  };
}

export interface AlbumTrackDto {
  id: string;
  title: string;
  durationMs: number;
  trackNumber: number | null;
  discNumber: number;
  status: string;
}

export interface AlbumDetailDto extends AlbumListItemDto {
  tracks: AlbumTrackDto[];
}

interface AlbumDetailRow extends AlbumListRow {
  tracks: Array<{
    id: string;
    title: string;
    durationMs: number;
    trackNumber: number | null;
    discNumber: number;
    status: string;
  }>;
}

function toDetail(row: AlbumDetailRow): AlbumDetailDto {
  return {
    ...toListItem(row),
    tracks: row.tracks.map((t) => ({
      id: t.id,
      title: t.title,
      durationMs: t.durationMs,
      trackNumber: t.trackNumber,
      discNumber: t.discNumber,
      status: t.status,
    })),
  };
}

const trackOrder: Prisma.TrackOrderByWithRelationInput[] = [
  { discNumber: 'asc' },
  { trackNumber: { sort: 'asc', nulls: 'last' } },
];

const detailInclude = {
  artist: { select: { name: true } },
  _count: { select: { tracks: { where: { deletedAt: null } } } },
  tracks: {
    where: { deletedAt: null },
    select: {
      id: true,
      title: true,
      durationMs: true,
      trackNumber: true,
      discNumber: true,
      status: true,
    },
    orderBy: trackOrder,
  },
} satisfies Prisma.AlbumInclude;

export interface ListAlbumsQuery extends PaginationQuery {
  q?: string;
  artistId?: string;
  albumType?: AlbumType;
}

export async function listAlbums(
  query: ListAlbumsQuery,
  db: Db = prisma,
): Promise<PageEnvelope<AlbumListItemDto>> {
  const p = parsePagination(query);
  const where: Prisma.AlbumWhereInput = {
    deletedAt: null,
    ...(query.artistId ? { artistId: query.artistId } : {}),
    ...(query.albumType ? { albumType: query.albumType } : {}),
    ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.album.findMany({
      where,
      include: {
        artist: { select: { name: true } },
        _count: { select: { tracks: { where: { deletedAt: null } } } },
      },
      // Newest releases first; undated albums sort after dated ones.
      orderBy: [{ releaseDate: { sort: 'desc', nulls: 'last' } }, { title: 'asc' }],
      skip: p.skip,
      take: p.limit,
    }),
    db.album.count({ where }),
  ]);
  return pageEnvelope(rows.map(toListItem), total, p);
}

export async function getAlbum(id: string, db: Db = prisma): Promise<AlbumDetailDto> {
  const row = await db.album.findFirst({
    where: { id, deletedAt: null },
    include: detailInclude,
  });
  if (!row) {
    throw notFound('Album not found.');
  }
  return toDetail(row);
}

export interface CreateAlbumInput {
  title: string;
  artistId: string;
  albumType?: AlbumType;
  releaseDate?: string;
  coverArtUrl?: string | null;
}

async function findManageableArtist(
  artistId: string,
  actor: AuthUser,
  db: Db,
): Promise<{ id: string; ownerUserId: string | null }> {
  const artist = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    select: { id: true, ownerUserId: true },
  });
  if (!artist) {
    throw notFound('Artist not found.');
  }
  if (!canManageArtist(actor, artist)) {
    throw forbidden('Only the artist owner or an admin can manage this catalog.');
  }
  return artist;
}

export async function createAlbum(
  input: CreateAlbumInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<AlbumDetailDto> {
  await findManageableArtist(input.artistId, actor, db);
  const row = await db.album.create({
    data: {
      title: input.title.trim(),
      artistId: input.artistId,
      ...(input.albumType !== undefined ? { albumType: input.albumType } : {}),
      ...(input.releaseDate !== undefined ? { releaseDate: new Date(input.releaseDate) } : {}),
      ...(input.coverArtUrl !== undefined ? { coverArtUrl: input.coverArtUrl } : {}),
    },
    include: detailInclude,
  });
  return toDetail(row);
}

export interface UpdateAlbumInput {
  title?: string;
  albumType?: AlbumType;
  releaseDate?: string | null;
  coverArtUrl?: string | null;
}

export async function updateAlbum(
  id: string,
  input: UpdateAlbumInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<AlbumDetailDto> {
  const existing = await db.album.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, artist: { select: { id: true, ownerUserId: true } } },
  });
  if (!existing) {
    throw notFound('Album not found.');
  }
  if (!canManageArtist(actor, existing.artist)) {
    throw forbidden('Only the artist owner or an admin can manage this catalog.');
  }

  const row = await db.album.update({
    where: { id },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.albumType !== undefined ? { albumType: input.albumType } : {}),
      ...(input.releaseDate !== undefined
        ? { releaseDate: input.releaseDate === null ? null : new Date(input.releaseDate) }
        : {}),
      ...(input.coverArtUrl !== undefined ? { coverArtUrl: input.coverArtUrl } : {}),
    },
    include: detailInclude,
  });
  return toDetail(row);
}

export async function deleteAlbum(id: string, actor: AuthUser, db: Db = prisma): Promise<void> {
  const existing = await db.album.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      artist: { select: { id: true, ownerUserId: true } },
      _count: { select: { tracks: { where: { deletedAt: null } } } },
    },
  });
  if (!existing) {
    throw notFound('Album not found.');
  }
  if (!canManageArtist(actor, existing.artist)) {
    throw forbidden('Only the artist owner or an admin can manage this catalog.');
  }
  if (existing._count.tracks > 0) {
    throw conflict("Remove the album's tracks first.");
  }
  await db.album.update({ where: { id }, data: { deletedAt: new Date() } });
}
