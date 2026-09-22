// Phase 21 — Royalty Engine. Artist-facing read service.
//
// All reads are ownership-isolated: the artist row must be manageable by
// the actor (canManageArtist). LISTENER callers never reach here (routes
// require ARTIST/ADMIN). Artist A can never see Artist B's earnings.
//
// Money is serialized as major-unit decimal strings ("1234.56").

import type { PrismaClient } from '@prisma/client';
import type { AuthUser } from '../../http/auth.js';
import { canManageArtist } from '../../http/authorization.js';
import { forbidden, notFound } from '../../http/errors.js';
import {
  parsePagination,
  pageEnvelope,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';
import { fromMinorUnits, toMinorUnits } from './money.js';

export interface RoyaltyDeps {
  db: PrismaClient;
}

function decToMinor(v: unknown): bigint {
  const s = v !== null && typeof v === 'object' && 'toString' in v ? String(v) : String(v);
  return toMinorUnits(s);
}

const fmt = (minor: bigint): string => fromMinorUnits(minor);

async function requireRoyaltyArtist(
  db: PrismaClient,
  artistId: string,
  actor: AuthUser,
): Promise<void> {
  const artist = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    select: { id: true, ownerUserId: true },
  });
  if (!artist) throw notFound('Artist not found.');
  if (!canManageArtist(actor, artist)) {
    throw forbidden('You can only view royalties for artists you own.');
  }
}

export interface RoyaltyOverviewDto {
  artistId: string;
  currency: string;
  totalEarnings: string;
  totalStreams: number;
  completedPeriods: number;
  latestPeriod: {
    periodId: string;
    periodStart: string;
    periodEnd: string;
    earnings: string;
    streams: number;
    runId: string;
    policyVersion: number;
  } | null;
}

/** Artist royalty overview: lifetime totals + latest completed period. */
export async function getRoyaltyOverview(
  artistId: string,
  actor: AuthUser,
  deps: RoyaltyDeps,
): Promise<RoyaltyOverviewDto> {
  const { db } = deps;
  await requireRoyaltyArtist(db, artistId, actor);

  const lines = await db.royaltyEarning.findMany({
    where: {
      artistId,
      run: { status: 'COMPLETED' },
    },
    select: {
      finalAmount: true,
      eligibleStreams: true,
      currency: true,
      runId: true,
      run: {
        select: {
          id: true,
          periodId: true,
          policy: { select: { version: true } },
          period: { select: { id: true, periodStart: true, periodEnd: true } },
        },
      },
    },
    orderBy: { run: { period: { periodStart: 'desc' } } },
  });

  let totalMinor = 0n;
  let totalStreams = 0;
  const seenPeriods = new Set<string>();
  let currency = 'USD';
  for (const l of lines) {
    totalMinor += decToMinor(l.finalAmount);
    totalStreams += Number(l.eligibleStreams);
    seenPeriods.add(l.run.periodId);
    currency = l.currency;
  }

  // Latest period = the most recent periodStart with earnings.
  let latestPeriod: RoyaltyOverviewDto['latestPeriod'] = null;
  if (lines.length > 0) {
    const byPeriod = new Map<
      string,
      { earnings: bigint; streams: number; meta: (typeof lines)[0]['run'] }
    >();
    for (const l of lines) {
      const e = byPeriod.get(l.run.periodId) ?? {
        earnings: 0n,
        streams: 0,
        meta: l.run,
      };
      e.earnings += decToMinor(l.finalAmount);
      e.streams += Number(l.eligibleStreams);
      // Keep the meta from the latest row (lines are ordered by periodStart desc).
      if (!byPeriod.has(l.run.periodId)) byPeriod.set(l.run.periodId, e);
      else {
        const cur = byPeriod.get(l.run.periodId)!;
        cur.earnings = e.earnings;
        cur.streams = e.streams;
      }
    }
    const first = lines[0].run;
    const agg = byPeriod.get(first.periodId)!;
    latestPeriod = {
      periodId: first.periodId,
      periodStart: first.period.periodStart.toISOString(),
      periodEnd: first.period.periodEnd.toISOString(),
      earnings: fmt(agg.earnings),
      streams: agg.streams,
      runId: first.id,
      policyVersion: first.policy.version,
    };
  }

  return {
    artistId,
    currency,
    totalEarnings: fmt(totalMinor),
    totalStreams,
    completedPeriods: seenPeriods.size,
    latestPeriod,
  };
}

export interface RoyaltyPeriodItemDto {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  currency: string;
  earnings: string;
  streams: number;
  runId: string | null;
  policyVersion: number | null;
}

/** Paginated royalty periods for an artist, with per-period earnings. */
export async function getRoyaltyPeriods(
  artistId: string,
  actor: AuthUser,
  query: PaginationQuery,
  deps: RoyaltyDeps,
): Promise<PageEnvelope<RoyaltyPeriodItemDto>> {
  const { db } = deps;
  await requireRoyaltyArtist(db, artistId, actor);
  const p = parsePagination(query);

  const total = await db.royaltyPeriod.count();
  const periods = await db.royaltyPeriod.findMany({
    orderBy: { periodStart: 'desc' },
    skip: p.skip,
    take: p.limit,
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      status: true,
      currency: true,
      runs: {
        where: { status: 'COMPLETED' },
        take: 1,
        select: {
          id: true,
          policy: { select: { version: true } },
          earnings: {
            where: { artistId },
            select: { finalAmount: true, eligibleStreams: true },
          },
        },
      },
    },
  });

  const data: RoyaltyPeriodItemDto[] = periods.map((per) => {
    const run = per.runs[0] ?? null;
    let earnings = 0n;
    let streams = 0;
    for (const e of run?.earnings ?? []) {
      earnings += decToMinor(e.finalAmount);
      streams += Number(e.eligibleStreams);
    }
    return {
      periodId: per.id,
      periodStart: per.periodStart.toISOString(),
      periodEnd: per.periodEnd.toISOString(),
      status: per.status,
      currency: per.currency,
      earnings: fmt(earnings),
      streams,
      runId: run?.id ?? null,
      policyVersion: run?.policy.version ?? null,
    };
  });
  return pageEnvelope(data, total, p);
}

export interface RoyaltyTrackEarningDto {
  trackId: string;
  title: string;
  eligibleStreams: number;
  allocationPercentage: string;
  grossAmount: string;
  adjustmentsTotal: string;
  finalAmount: string;
  currency: string;
}

/** Paginated per-track earnings for an artist in a completed period. */
export async function getRoyaltyPeriodTracks(
  artistId: string,
  periodId: string,
  actor: AuthUser,
  query: PaginationQuery,
  deps: RoyaltyDeps,
): Promise<PageEnvelope<RoyaltyTrackEarningDto>> {
  const { db } = deps;
  await requireRoyaltyArtist(db, artistId, actor);

  const period = await db.royaltyPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Royalty period not found.');

  const run = await db.royaltyCalculationRun.findFirst({
    where: { periodId, status: 'COMPLETED' },
    select: { id: true },
  });

  const p = parsePagination(query);
  if (!run) return pageEnvelope([], 0, p);

  const where = { runId: run.id, artistId };
  const total = await db.royaltyEarning.count({ where });
  const rows = await db.royaltyEarning.findMany({
    where,
    orderBy: [{ finalAmount: 'desc' }, { trackId: 'asc' }],
    skip: p.skip,
    take: p.limit,
    select: {
      trackId: true,
      eligibleStreams: true,
      allocationPercentage: true,
      grossAmount: true,
      adjustmentsTotal: true,
      finalAmount: true,
      currency: true,
      track: { select: { title: true } },
    },
  });

  const data: RoyaltyTrackEarningDto[] = rows.map((r) => ({
    trackId: r.trackId,
    title: r.track.title,
    eligibleStreams: Number(r.eligibleStreams),
    allocationPercentage: String(r.allocationPercentage),
    grossAmount: fmt(decToMinor(r.grossAmount)),
    adjustmentsTotal: fmt(decToMinor(r.adjustmentsTotal)),
    finalAmount: fmt(decToMinor(r.finalAmount)),
    currency: r.currency,
  }));
  return pageEnvelope(data, total, p);
}

export interface RoyaltyRunDto {
  runId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  policyVersion: number;
  policyName: string;
  status: string;
  currency: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** The requesting artist's own totals within this run (never platform totals). */
  artistEarnings: string;
  artistStreams: number;
  artistTrackCount: number;
}

/**
 * Calculation run detail for an artist. Only exposes the run if the artist
 * has earnings in it (ownership isolation at the run level). Platform-wide
 * totals (pool, total allocated, residual) are NOT exposed to artists.
 */
export async function getRoyaltyRun(
  artistId: string,
  runId: string,
  actor: AuthUser,
  deps: RoyaltyDeps,
): Promise<RoyaltyRunDto> {
  const { db } = deps;
  await requireRoyaltyArtist(db, artistId, actor);

  const run = await db.royaltyCalculationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      periodId: true,
      status: true,
      currency: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      policy: { select: { version: true, name: true } },
      period: { select: { periodStart: true, periodEnd: true } },
      earnings: {
        where: { artistId },
        select: { finalAmount: true, eligibleStreams: true },
      },
    },
  });
  if (!run) throw notFound('Royalty calculation run not found.');
  if (run.earnings.length === 0) {
    throw notFound('Royalty calculation run not found.');
  }

  let artistEarnings = 0n;
  let artistStreams = 0;
  for (const e of run.earnings) {
    artistEarnings += decToMinor(e.finalAmount);
    artistStreams += Number(e.eligibleStreams);
  }

  return {
    runId: run.id,
    periodId: run.periodId,
    periodStart: run.period.periodStart.toISOString(),
    periodEnd: run.period.periodEnd.toISOString(),
    policyVersion: run.policy.version,
    policyName: run.policy.name,
    status: run.status,
    currency: run.currency,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    artistEarnings: fmt(artistEarnings),
    artistStreams,
    artistTrackCount: run.earnings.length,
  };
}
