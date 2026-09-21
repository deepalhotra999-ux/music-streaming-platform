// Phase 4 — follows. Domain logic for the caller's followed artists.
// Following is idempotent, mirroring likes: following an already-followed
// artist succeeds without a duplicate, and unfollowing something not
// followed (or an artist that doesn't exist) still returns 204. Throws
// HttpProblem errors (see http/errors.ts) rendered as RFC 7807.

import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../db.js';
import { notFound } from '../../http/errors.js';
import {
  pageEnvelope,
  parsePagination,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';
import { toArtistSummary } from '../summaries.js';

type Db = PrismaClient;

interface ArtistRow {
  id: string;
  name: string;
  verified: boolean;
}

interface FollowRow {
  artistId: string;
  createdAt: Date;
  artist: ArtistRow;
}

export interface FollowItemDto {
  artistId: string;
  createdAt: Date;
  artist: ReturnType<typeof toArtistSummary>;
}

function toFollowItem(row: FollowRow): FollowItemDto {
  return {
    artistId: row.artistId,
    createdAt: row.createdAt,
    artist: toArtistSummary(row.artist),
  };
}

export async function listFollows(
  userId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<FollowItemDto>> {
  const p = parsePagination(query);
  // Follows on soft-deleted artists are hidden, not deleted.
  const where = { userId, artist: { deletedAt: null } };
  const [rows, total] = await Promise.all([
    db.follow.findMany({
      where,
      include: { artist: true },
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.follow.count({ where }),
  ]);
  return pageEnvelope(rows.map(toFollowItem), total, p);
}

export async function followArtist(
  userId: string,
  artistId: string,
  db: Db = prisma,
): Promise<{ created: boolean; item: FollowItemDto }> {
  const artist = await db.artist.findFirst({ where: { id: artistId, deletedAt: null } });
  if (!artist) {
    throw notFound('Artist not found.');
  }
  const existing = await db.follow.findUnique({
    where: { userId_artistId: { userId, artistId } },
  });
  if (existing) {
    return {
      created: false,
      item: toFollowItem({ artistId, createdAt: existing.createdAt, artist }),
    };
  }
  const row = await db.follow.create({
    data: { userId, artistId },
    include: { artist: true },
  });
  return { created: true, item: toFollowItem(row) };
}

export async function unfollowArtist(
  userId: string,
  artistId: string,
  db: Db = prisma,
): Promise<void> {
  // Idempotent: 0 rows deleted is fine.
  await db.follow.deleteMany({ where: { userId, artistId } });
}
