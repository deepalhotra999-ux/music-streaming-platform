// Phase 4 — genres. Domain logic: public reads, admin-only management.
// Genres have no soft-delete column, so deletion is a hard delete guarded by
// a "no tracks reference it" check. Throws HttpProblem errors (see
// http/errors.ts) which the central handler renders as RFC 7807.

import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { conflict, notFound } from '../../http/errors.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';

type Db = PrismaClient;

export interface GenreDto {
  id: string;
  name: string;
  description: string | null;
  trackCount: number;
}

interface GenreRow {
  id: string;
  name: string;
  description: string | null;
  _count: { tracks: number };
}

function toGenre(row: GenreRow): GenreDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trackCount: row._count.tracks,
  };
}

const withTrackCount = {
  _count: { select: { tracks: true } },
} as const;

export interface ListGenresQuery extends PaginationQuery {
  q?: string;
}

export async function listGenres(
  query: ListGenresQuery,
  db: Db = prisma,
): Promise<PageEnvelope<GenreDto>> {
  const p = parsePagination(query);
  const where: Prisma.GenreWhereInput = query.q
    ? { name: { contains: query.q, mode: 'insensitive' } }
    : {};
  const [rows, total] = await Promise.all([
    db.genre.findMany({
      where,
      include: withTrackCount,
      orderBy: { name: 'asc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.genre.count({ where }),
  ]);
  return pageEnvelope(rows.map(toGenre), total, p);
}

export async function getGenre(id: string, db: Db = prisma): Promise<GenreDto> {
  const row = await db.genre.findUnique({
    where: { id },
    include: withTrackCount,
  });
  if (!row) {
    throw notFound('Genre not found.');
  }
  return toGenre(row);
}

export interface CreateGenreInput {
  name: string;
  description?: string | null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export async function createGenre(input: CreateGenreInput, db: Db = prisma): Promise<GenreDto> {
  try {
    const row = await db.genre.create({
      data: {
        name: input.name.trim(),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      include: withTrackCount,
    });
    return toGenre(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('A genre with this name already exists.');
    }
    throw err;
  }
}

export interface UpdateGenreInput {
  name?: string;
  description?: string | null;
}

export async function updateGenre(
  id: string,
  input: UpdateGenreInput,
  db: Db = prisma,
): Promise<GenreDto> {
  const existing = await db.genre.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw notFound('Genre not found.');
  }
  try {
    const row = await db.genre.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      include: withTrackCount,
    });
    return toGenre(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict('A genre with this name already exists.');
    }
    throw err;
  }
}

export async function deleteGenre(id: string, db: Db = prisma): Promise<void> {
  const existing = await db.genre.findUnique({
    where: { id },
    include: { _count: { select: { tracks: true } } },
  });
  if (!existing) {
    throw notFound('Genre not found.');
  }
  if (existing._count.tracks > 0) {
    throw conflict('Cannot delete a genre that is assigned to tracks.');
  }
  await db.genre.delete({ where: { id } });
}
