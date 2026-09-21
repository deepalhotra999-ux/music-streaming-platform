// Phase 4 — listening history. Domain logic for recording and reading the
// caller's plays. A completed play also increments the track's playCount;
// both writes happen in one transaction so the counter can't drift from the
// history rows. Throws HttpProblem errors (see http/errors.ts) rendered as
// RFC 7807.

import type { PrismaClient, TrackStatus } from '@prisma/client';
import { prisma } from '../../db.js';
import { badRequest, notFound } from '../../http/errors.js';
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

interface HistoryRow {
  id: string;
  trackId: string;
  playedAt: Date;
  progressMs: number | null;
  completed: boolean;
  track: TrackRow;
}

export interface HistoryItemDto {
  id: string;
  trackId: string;
  playedAt: Date;
  progressMs: number | null;
  completed: boolean;
  track: ReturnType<typeof toTrackSummary>;
}

/** Artist/album names needed by toTrackSummary. */
const trackNames = {
  artist: { select: { name: true } },
  album: { select: { title: true } },
} as const;

function toHistoryItem(row: HistoryRow): HistoryItemDto {
  return {
    id: row.id,
    trackId: row.trackId,
    playedAt: row.playedAt,
    progressMs: row.progressMs,
    completed: row.completed,
    track: toTrackSummary(row.track),
  };
}

export async function listHistory(
  userId: string,
  query: PaginationQuery,
  db: Db = prisma,
): Promise<PageEnvelope<HistoryItemDto>> {
  const p = parsePagination(query);
  // Entries whose track was soft-deleted are hidden, not deleted.
  const where = { userId, track: { deletedAt: null } };
  const [rows, total] = await Promise.all([
    db.listeningHistory.findMany({
      where,
      include: { track: { include: trackNames } },
      orderBy: { playedAt: 'desc' },
      skip: p.skip,
      take: p.limit,
    }),
    db.listeningHistory.count({ where }),
  ]);
  return pageEnvelope(rows.map(toHistoryItem), total, p);
}

export interface RecordPlayInput {
  trackId: string;
  progressMs?: number | null;
  completed?: boolean;
}

export async function recordPlay(
  userId: string,
  input: RecordPlayInput,
  db: Db = prisma,
): Promise<HistoryItemDto> {
  const track = await db.track.findFirst({
    where: { id: input.trackId, deletedAt: null },
    include: trackNames,
  });
  if (!track) {
    throw notFound('Track not found.');
  }
  const progressMs = input.progressMs ?? null;
  if (progressMs !== null && progressMs > track.durationMs) {
    throw badRequest('progressMs exceeds track duration.');
  }
  const completed = input.completed ?? false;

  const entry = await db.$transaction(async (tx) => {
    const row = await tx.listeningHistory.create({
      data: { userId, trackId: track.id, progressMs, completed },
      include: { track: { include: trackNames } },
    });
    if (completed) {
      await tx.track.update({
        where: { id: track.id },
        data: { playCount: { increment: 1 } },
      });
    }
    return row;
  });
  return toHistoryItem(entry);
}

export async function clearHistory(userId: string, db: Db = prisma): Promise<void> {
  await db.listeningHistory.deleteMany({ where: { userId } });
}
