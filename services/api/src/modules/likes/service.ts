// Phase 4 — likes. Domain logic for the caller's liked tracks. Liking is
// idempotent: liking an already-liked track succeeds without a duplicate,
// and unliking something not liked (or a track that doesn't exist) still
// returns 204 so clients can't probe state. Throws HttpProblem errors
// (see http/errors.ts) rendered as RFC 7807.

import type { PrismaClient, TrackStatus } from '@prisma/client';
import { prisma } from '../../db.js';
import { notFound } from '../../http/errors.js';
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
  artist: { name: string };
  album: { title: string } | null;
}

interface LikeRow {
  trackId: string;
  createdAt: Date;
  track: TrackRow;
}

export interface LikeItemDto {
  trackId: string;
  createdAt: Date;
  track: ReturnType<typeof toTrackSummary>;
}

/** Artist/album names needed by toTrackSummary. */
const trackNames = {
  artist: { select: { name: true } },
  album: { select: { title: true } },
} as const;

function toLikeItem(row: LikeRow): LikeItemDto {
  return {
    trackId: row.trackId,
    createdAt: row.createdAt,
    track: toTrackSummary(row.track),
  };
}

export async function listLikes(
  userId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<LikeItemDto>> {
  const p = parsePagination(query);
  // Likes on soft-deleted tracks are hidden, not deleted.
  const where = { userId, track: { deletedAt: null } };
  const [rows, total] = await Promise.all([
    db.like.findMany({
      where,
      include: { track: { include: trackNames } },
      orderBy: { createdAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.like.count({ where }),
  ]);
  return pageEnvelope(rows.map(toLikeItem), total, p);
}

export async function likeTrack(
  userId: string,
  trackId: string,
  db: Db = prisma,
): Promise<{ created: boolean; item: LikeItemDto }> {
  const track = await db.track.findFirst({
    where: { id: trackId, deletedAt: null },
    include: trackNames,
  });
  if (!track) {
    throw notFound('Track not found.');
  }
  const existing = await db.like.findUnique({
    where: { userId_trackId: { userId, trackId } },
  });
  if (existing) {
    return {
      created: false,
      item: toLikeItem({ trackId, createdAt: existing.createdAt, track }),
    };
  }
  const row = await db.like.create({
    data: { userId, trackId },
    include: { track: { include: trackNames } },
  });
  return { created: true, item: toLikeItem(row) };
}

export async function unlikeTrack(userId: string, trackId: string, db: Db = prisma): Promise<void> {
  // Idempotent: 0 rows deleted is fine.
  await db.like.deleteMany({ where: { userId, trackId } });
}
