// Phase 4 — tracks. Domain logic: public catalog reads plus owner/admin
// management of an artist's tracks. Throws HttpProblem errors (see
// http/errors.ts) which the central handler renders as RFC 7807.

import { Prisma, type PrismaClient, type TrackStatus, type AudioIngestStatus } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessableEntity } from '../../http/errors.js';
import type { AuthUser } from '../../http/auth.js';
import { canManageArtist } from '../../http/authorization.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

type Db = PrismaClient;

interface TrackListRow {
  id: string;
  title: string;
  artistId: string;
  artist: { name: string };
  albumId: string | null;
  album: { title: string } | null;
  durationMs: number;
  trackNumber: number | null;
  discNumber: number;
  status: TrackStatus;
  audioStatus: AudioIngestStatus;
  playCount: bigint;
  createdAt: Date;
}

export interface TrackListItemDto {
  id: string;
  title: string;
  artistId: string;
  artistName: string;
  albumId: string | null;
  albumTitle: string | null;
  durationMs: number;
  trackNumber: number | null;
  discNumber: number;
  status: TrackStatus;
  audioStatus: AudioIngestStatus;
  playCount: number;
  createdAt: Date;
}

function toListItem(row: TrackListRow): TrackListItemDto {
  return {
    id: row.id,
    title: row.title,
    artistId: row.artistId,
    artistName: row.artist.name,
    albumId: row.albumId,
    albumTitle: row.album?.title ?? null,
    durationMs: row.durationMs,
    trackNumber: row.trackNumber,
    discNumber: row.discNumber,
    status: row.status,
    audioStatus: row.audioStatus,
    playCount: Number(row.playCount),
    createdAt: row.createdAt,
  };
}

export interface TrackDetailDto extends TrackListItemDto {
  isrc: string | null;
  genres: Array<{ id: string; name: string }>;
  likeCount: number;
}

interface TrackDetailRow extends TrackListRow {
  isrc: string | null;
  genres: Array<{ genre: { id: string; name: string } }>;
  _count: { likes: number };
}

function toDetail(row: TrackDetailRow): TrackDetailDto {
  return {
    ...toListItem(row),
    isrc: row.isrc,
    genres: row.genres.map((g) => ({ id: g.genre.id, name: g.genre.name })),
    likeCount: row._count.likes,
  };
}

const listInclude = {
  artist: { select: { name: true } },
  album: { select: { title: true } },
} as const;

const detailInclude = {
  artist: { select: { name: true } },
  album: { select: { title: true } },
  genres: { include: { genre: { select: { id: true, name: true } } } },
  _count: { select: { likes: true } },
} as const;

export interface ListTracksQuery extends PaginationQuery {
  q?: string;
  artistId?: string;
  albumId?: string;
  genreId?: string;
  status?: TrackStatus;
}

export async function listTracks(
  query: ListTracksQuery,
  db: Db = prisma,
): Promise<PageEnvelope<TrackListItemDto>> {
  const p = parsePagination(query);
  const where: Prisma.TrackWhereInput = {
    deletedAt: null,
    ...(query.artistId ? { artistId: query.artistId } : {}),
    ...(query.albumId ? { albumId: query.albumId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.genreId ? { genres: { some: { genreId: query.genreId } } } : {}),
    ...(query.q ? { title: { contains: query.q, mode: 'insensitive' } } : {}),
  };
  const [rows, total] = await Promise.all([
    db.track.findMany({
      where,
      include: listInclude,
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.track.count({ where }),
  ]);
  return pageEnvelope(rows.map(toListItem), total, p);
}

export async function getTrack(id: string, db: Db = prisma): Promise<TrackDetailDto> {
  const row = await db.track.findFirst({
    where: { id, deletedAt: null },
    include: detailInclude,
  });
  if (!row) {
    throw notFound('Track not found.');
  }
  return toDetail(row);
}

export interface CreateTrackInput {
  title: string;
  artistId: string;
  albumId?: string | null;
  durationMs: number;
  trackNumber?: number | null;
  discNumber?: number;
  isrc?: string | null;
  status?: TrackStatus;
}

/** 404 unless the artist exists and the caller may manage its catalog. */
async function checkManageableArtist(artistId: string, actor: AuthUser, db: Db): Promise<void> {
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
}

/** Resolves an optional album id to a settable value, validating ownership. */
async function resolveAlbumId(
  artistId: string,
  albumId: string | null | undefined,
  db: Db,
): Promise<string | null | undefined> {
  if (albumId === undefined) return undefined;
  if (albumId === null) return null;
  const album = await db.album.findFirst({
    where: { id: albumId, deletedAt: null },
    select: { id: true, artistId: true },
  });
  if (!album) {
    throw notFound('Album not found.');
  }
  if (album.artistId !== artistId) {
    throw badRequest('Album does not belong to this artist.');
  }
  return album.id;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function createTrack(
  input: CreateTrackInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<TrackDetailDto> {
  await checkManageableArtist(input.artistId, actor, db);
  const albumId = await resolveAlbumId(input.artistId, input.albumId, db);
  // Phase 14 — READY is owned by the audio pipeline: a track becomes
  // playable only after an upload is transcoded and its HLS package
  // validates. Clients cannot claim readiness by hand.
  if (input.status === 'READY') {
    throw unprocessableEntity(
      'Track readiness is determined by the audio processing pipeline. Upload audio to make a track playable.',
    );
  }

  try {
    const row = await db.track.create({
      data: {
        title: input.title.trim(),
        artistId: input.artistId,
        ...(albumId !== undefined ? { albumId } : {}),
        durationMs: input.durationMs,
        ...(input.trackNumber !== undefined ? { trackNumber: input.trackNumber } : {}),
        ...(input.discNumber !== undefined ? { discNumber: input.discNumber } : {}),
        ...(input.isrc !== undefined ? { isrc: input.isrc } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      include: detailInclude,
    });
    return toDetail(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('A track with this ISRC already exists.');
    }
    throw err;
  }
}

export interface UpdateTrackInput {
  title?: string;
  albumId?: string | null;
  durationMs?: number;
  trackNumber?: number | null;
  discNumber?: number;
  isrc?: string | null;
  status?: TrackStatus;
}

export async function updateTrack(
  id: string,
  input: UpdateTrackInput,
  actor: AuthUser,
  db: Db = prisma,
): Promise<TrackDetailDto> {
  const existing = await db.track.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      artistId: true,
      artist: { select: { id: true, ownerUserId: true } },
    },
  });
  if (!existing) {
    throw notFound('Track not found.');
  }
  if (!canManageArtist(actor, existing.artist)) {
    throw forbidden('Only the artist owner or an admin can manage this catalog.');
  }
  // Phase 14 — same as create: only the pipeline may mark a track READY.
  // Manual transitions that stay meaningful: PROCESSING (unpublish),
  // FAILED, and TAKEDOWN (takedown/restore flows).
  if (input.status === 'READY') {
    throw unprocessableEntity(
      'Track readiness is determined by the audio processing pipeline. Upload audio to make a track playable.',
    );
  }
  const albumId = await resolveAlbumId(existing.artistId, input.albumId, db);

  try {
    const row = await db.track.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(albumId !== undefined ? { albumId } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.trackNumber !== undefined ? { trackNumber: input.trackNumber } : {}),
        ...(input.discNumber !== undefined ? { discNumber: input.discNumber } : {}),
        ...(input.isrc !== undefined ? { isrc: input.isrc } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
      include: detailInclude,
    });
    return toDetail(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('A track with this ISRC already exists.');
    }
    throw err;
  }
}

export async function deleteTrack(id: string, actor: AuthUser, db: Db = prisma): Promise<void> {
  const existing = await db.track.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, artist: { select: { id: true, ownerUserId: true } } },
  });
  if (!existing) {
    throw notFound('Track not found.');
  }
  if (!canManageArtist(actor, existing.artist)) {
    throw forbidden('Only the artist owner or an admin can manage this catalog.');
  }
  const inPlaylists = await db.playlistTrack.count({ where: { trackId: id } });
  if (inPlaylists > 0) {
    throw conflict('Track is in playlists; remove it from playlists first.');
  }
  await db.track.update({ where: { id }, data: { deletedAt: new Date() } });
}
