// Phase 21 — Royalty Engine. Admin service.
//
// ADMIN-only. Write operations create policies, periods, and revenue
// inputs (the verified financial inputs the engine consumes). Inspection
// endpoints are read-only. There are deliberately NO payout controls, NO
// manual earnings editing, and NO entitlement changes in this phase.

import type { PrismaClient } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../http/errors.js';
import {
  parsePagination,
  pageEnvelope,
  type PageEnvelope,
  type PaginationQuery,
} from '../../http/pagination.js';
import { toMinorUnits, fromMinorUnits } from './money.js';

export interface RoyaltyDeps {
  db: PrismaClient;
}

function decStr(v: unknown): string {
  return v !== null && typeof v === 'object' && 'toString' in v ? String(v) : String(v);
}
const fmt = (minor: bigint): string => fromMinorUnits(minor);
const toMinor = (v: unknown): bigint => toMinorUnits(decStr(v));

// --- Policies ---

export interface CreatePolicyInput {
  name: string;
  artistPoolPercentage: string;
  minimumStreams: number | null;
  currency: string;
  effectiveFrom: string;
  actorId: string | null;
}

export async function createPolicy(input: CreatePolicyInput, deps: RoyaltyDeps) {
  const { db } = deps;
  const pct = Number(input.artistPoolPercentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw badRequest('artistPoolPercentage must be between 0 and 100.');
  }
  const maxVersion = await db.royaltyPolicy.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = (maxVersion?.version ?? 0) + 1;
  const policy = await db.royaltyPolicy.create({
    data: {
      version,
      name: input.name,
      status: 'DRAFT',
      artistPoolPercentage: input.artistPoolPercentage,
      minimumStreams: input.minimumStreams,
      currency: input.currency,
      roundingMode: 'HALF_UP',
      effectiveFrom: new Date(input.effectiveFrom),
      createdBy: input.actorId,
    },
  });
  return toPolicyDto(policy);
}

function toPolicyDto(p: {
  id: string;
  version: number;
  name: string;
  status: string;
  artistPoolPercentage: unknown;
  minimumStreams: number | null;
  currency: string;
  roundingMode: string;
  effectiveFrom: Date;
  createdAt: Date;
}) {
  return {
    id: p.id,
    version: p.version,
    name: p.name,
    status: p.status,
    artistPoolPercentage: decStr(p.artistPoolPercentage),
    minimumStreams: p.minimumStreams,
    currency: p.currency,
    roundingMode: p.roundingMode,
    effectiveFrom: p.effectiveFrom.toISOString(),
    createdAt: p.createdAt.toISOString(),
  };
}

export async function listPolicies(query: PaginationQuery, deps: RoyaltyDeps) {
  const { db } = deps;
  const p = parsePagination(query);
  const total = await db.royaltyPolicy.count();
  const rows = await db.royaltyPolicy.findMany({
    orderBy: { version: 'desc' },
    skip: p.skip,
    take: p.limit,
  });
  return pageEnvelope(rows.map(toPolicyDto), total, p);
}

/** Activate a DRAFT policy. The previously active policy is retired. */
export async function activatePolicy(policyId: string, deps: RoyaltyDeps) {
  const { db } = deps;
  const policy = await db.royaltyPolicy.findUnique({ where: { id: policyId } });
  if (!policy) throw notFound('Royalty policy not found.');
  if (policy.status !== 'DRAFT') throw badRequest('Only DRAFT policies can be activated.');

  await db.$transaction(async (tx) => {
    await tx.royaltyPolicy.updateMany({
      where: { status: 'ACTIVE' },
      data: { status: 'RETIRED' },
    });
    await tx.royaltyPolicy.update({
      where: { id: policyId },
      data: { status: 'ACTIVE' },
    });
  });
  const updated = await db.royaltyPolicy.findUniqueOrThrow({ where: { id: policyId } });
  return toPolicyDto(updated);
}

// --- Periods ---

export async function createPeriod(
  input: { periodStart: string; periodEnd: string; currency?: string; actorId: string | null },
  deps: RoyaltyDeps,
) {
  const { db } = deps;
  const start = new Date(input.periodStart);
  const end = new Date(input.periodEnd);
  if (!(start < end)) throw badRequest('periodEnd must be after periodStart.');
  try {
    const period = await db.royaltyPeriod.create({
      data: {
        periodStart: start,
        periodEnd: end,
        currency: input.currency ?? 'USD',
        status: 'OPEN',
        createdBy: input.actorId,
      },
    });
    return {
      periodId: period.id,
      periodStart: period.periodStart.toISOString(),
      periodEnd: period.periodEnd.toISOString(),
      status: period.status,
      currency: period.currency,
    };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('Unique constraint')) {
      throw conflict('A period with these exact boundaries already exists.');
    }
    throw e;
  }
}

// --- Revenue inputs ---

export interface CreateRevenueInput {
  periodId: string;
  source: string;
  currency: string;
  grossAmount: string;
  deductions?: string;
  referenceId: string;
  fxReference?: string | null;
  actorId: string | null;
}

export async function createRevenueInput(input: CreateRevenueInput, deps: RoyaltyDeps) {
  const { db } = deps;
  const period = await db.royaltyPeriod.findUnique({ where: { id: input.periodId } });
  if (!period) throw notFound('Royalty period not found.');
  if (period.status === 'COMPLETED') {
    throw badRequest('Period is COMPLETED; revenue inputs cannot be added. Create a new period.');
  }
  if (input.currency !== period.currency) {
    throw badRequest(
      `Revenue currency ${input.currency} does not match period currency ${period.currency}.`,
    );
  }
  const grossMinor = toMinorUnits(input.grossAmount);
  const dedMinor = toMinorUnits(input.deductions ?? '0.00');
  if (grossMinor < 0n || dedMinor < 0n) throw badRequest('Amounts must be >= 0.');
  if (dedMinor > grossMinor) throw badRequest('Deductions cannot exceed gross amount.');
  const netMinor = grossMinor - dedMinor;

  try {
    const row = await db.royaltyRevenueInput.create({
      data: {
        periodId: input.periodId,
        source: input.source,
        currency: input.currency,
        grossAmount: fromMinorUnits(grossMinor),
        deductions: fromMinorUnits(dedMinor),
        netAmount: fromMinorUnits(netMinor),
        referenceId: input.referenceId,
        fxReference: input.fxReference ?? null,
        createdBy: input.actorId,
      },
    });
    return {
      id: row.id,
      periodId: row.periodId,
      source: row.source,
      currency: row.currency,
      grossAmount: fmt(toMinor(row.grossAmount)),
      deductions: fmt(toMinor(row.deductions)),
      netAmount: fmt(toMinor(row.netAmount)),
      referenceId: row.referenceId,
    };
  } catch (e: unknown) {
    if (e instanceof Error && /unique|Unique/i.test(e.message)) {
      throw conflict(`Revenue input with referenceId "${input.referenceId}" already exists.`);
    }
    throw e;
  }
}

// --- Run inspection ---

export interface AdminRunDto {
  runId: string;
  runKey: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  policyVersion: number;
  policyName: string;
  status: string;
  totalEligibleStreams: number;
  royaltyPool: string;
  totalAllocated: string;
  residualAmount: string;
  currency: string;
  artistCount: number;
  trackCount: number;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
}

function toAdminRunDto(
  run: {
    id: string;
    runKey: string;
    periodId: string;
    status: string;
    totalEligibleStreams: bigint | number;
    royaltyPool: unknown;
    totalAllocated: unknown;
    residualAmount: unknown;
    currency: string;
    startedAt: Date | null;
    completedAt: Date | null;
    error: string | null;
    createdAt: Date;
    policy: { version: number; name: string };
    period: { periodStart: Date; periodEnd: Date };
    _count: { earnings: number };
  },
  artistCount: number,
): AdminRunDto {
  return {
    runId: run.id,
    runKey: run.runKey,
    periodId: run.periodId,
    periodStart: run.period.periodStart.toISOString(),
    periodEnd: run.period.periodEnd.toISOString(),
    policyVersion: run.policy.version,
    policyName: run.policy.name,
    status: run.status,
    totalEligibleStreams: Number(run.totalEligibleStreams),
    royaltyPool: fmt(toMinor(run.royaltyPool)),
    totalAllocated: fmt(toMinor(run.totalAllocated)),
    residualAmount: fmt(toMinor(run.residualAmount)),
    currency: run.currency,
    artistCount,
    trackCount: run._count.earnings,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
  };
}

export async function listRuns(
  query: PaginationQuery,
  deps: RoyaltyDeps,
): Promise<PageEnvelope<AdminRunDto>> {
  const { db } = deps;
  const p = parsePagination(query);
  const total = await db.royaltyCalculationRun.count();
  const runs = await db.royaltyCalculationRun.findMany({
    orderBy: { createdAt: 'desc' },
    skip: p.skip,
    take: p.limit,
    select: {
      id: true,
      runKey: true,
      periodId: true,
      status: true,
      totalEligibleStreams: true,
      royaltyPool: true,
      totalAllocated: true,
      residualAmount: true,
      currency: true,
      startedAt: true,
      completedAt: true,
      error: true,
      createdAt: true,
      policy: { select: { version: true, name: true } },
      period: { select: { periodStart: true, periodEnd: true } },
      _count: { select: { earnings: true } },
    },
  });
  // Artist count per run (distinct artists with earnings).
  const data: AdminRunDto[] = [];
  for (const r of runs) {
    const artists = await db.royaltyEarning.groupBy({
      by: ['artistId'],
      where: { runId: r.id },
    });
    data.push(toAdminRunDto(r, artists.length));
  }
  return pageEnvelope(data, total, p);
}

export async function getRun(runId: string, deps: RoyaltyDeps): Promise<AdminRunDto> {
  const { db } = deps;
  const run = await db.royaltyCalculationRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      runKey: true,
      periodId: true,
      status: true,
      totalEligibleStreams: true,
      royaltyPool: true,
      totalAllocated: true,
      residualAmount: true,
      currency: true,
      startedAt: true,
      completedAt: true,
      error: true,
      createdAt: true,
      policy: { select: { version: true, name: true } },
      period: { select: { periodStart: true, periodEnd: true } },
      _count: { select: { earnings: true } },
    },
  });
  if (!run) throw notFound('Royalty calculation run not found.');
  const artists = await db.royaltyEarning.groupBy({ by: ['artistId'], where: { runId } });
  return toAdminRunDto(run, artists.length);
}

export interface RunArtistTotalDto {
  artistId: string;
  artistName: string;
  trackCount: number;
  totalStreams: number;
  totalEarnings: string;
  currency: string;
}

/** Artist-level totals for a run (paginated). */
export async function getRunArtistTotals(
  runId: string,
  query: PaginationQuery,
  deps: RoyaltyDeps,
): Promise<PageEnvelope<RunArtistTotalDto>> {
  const { db } = deps;
  const run = await db.royaltyCalculationRun.findUnique({
    where: { id: runId },
    select: { id: true, currency: true },
  });
  if (!run) throw notFound('Royalty calculation run not found.');
  const p = parsePagination(query);

  const groups = await db.royaltyEarning.groupBy({
    by: ['artistId'],
    where: { runId },
    _sum: { finalAmount: true, eligibleStreams: true },
    _count: { trackId: true },
  });
  // Deterministic order: earnings desc, artistId asc.
  const withNames = await Promise.all(
    groups.map(async (g) => {
      const artist = await db.artist.findUnique({
        where: { id: g.artistId },
        select: { name: true },
      });
      return {
        artistId: g.artistId,
        artistName: artist?.name ?? '(deleted)',
        trackCount: g._count.trackId,
        totalStreams: Number(g._sum.eligibleStreams ?? 0n),
        totalEarnings: fmt(toMinor(g._sum.finalAmount)),
        currency: run.currency,
      };
    }),
  );
  withNames.sort(
    (a, b) => b.totalEarnings.localeCompare(a.totalEarnings) || (a.artistId < b.artistId ? -1 : 1),
  );
  const total = withNames.length;
  const data = withNames.slice(p.skip, p.skip + p.limit);
  return pageEnvelope(data, total, p);
}

export interface PeriodDetailDto {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  currency: string;
  revenueInputs: Array<{
    id: string;
    source: string;
    currency: string;
    grossAmount: string;
    deductions: string;
    netAmount: string;
    referenceId: string;
  }>;
  totalNetRevenue: string;
  runs: AdminRunDto[];
}

export interface PeriodListItemDto {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  currency: string;
  revenueInputCount: number;
  totalNetRevenue: string;
  runCount: number;
}

/** Paginated period list with revenue and run summaries. */
export async function listPeriods(
  query: PaginationQuery,
  deps: RoyaltyDeps,
): Promise<PageEnvelope<PeriodListItemDto>> {
  const { db } = deps;
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
      revenueInputs: { select: { netAmount: true } },
      _count: { select: { runs: true } },
    },
  });
  const data: PeriodListItemDto[] = periods.map((per) => {
    let netTotal = 0n;
    for (const r of per.revenueInputs) {
      netTotal += toMinor(r.netAmount);
    }
    return {
      periodId: per.id,
      periodStart: per.periodStart.toISOString(),
      periodEnd: per.periodEnd.toISOString(),
      status: per.status,
      currency: per.currency,
      revenueInputCount: per.revenueInputs.length,
      totalNetRevenue: fmt(netTotal),
      runCount: per._count.runs,
    };
  });
  return pageEnvelope(data, total, p);
}

export interface RunTrackTotalDto {
  trackId: string;
  trackTitle: string;
  artistId: string;
  artistName: string;
  eligibleStreams: number;
  allocationPercentage: string;
  grossAmount: string;
  currency: string;
}

/** Track-level totals for a run (paginated). */
export async function getRunTrackTotals(
  runId: string,
  query: PaginationQuery,
  deps: RoyaltyDeps,
): Promise<PageEnvelope<RunTrackTotalDto>> {
  const { db } = deps;
  const run = await db.royaltyCalculationRun.findUnique({
    where: { id: runId },
    select: { id: true, currency: true },
  });
  if (!run) throw notFound('Royalty calculation run not found.');
  const p = parsePagination(query);

  const total = await db.royaltyEarning.count({ where: { runId } });
  const rows = await db.royaltyEarning.findMany({
    where: { runId },
    orderBy: [{ finalAmount: 'desc' }, { trackId: 'asc' }],
    skip: p.skip,
    take: p.limit,
    select: {
      trackId: true,
      artistId: true,
      eligibleStreams: true,
      allocationPercentage: true,
      grossAmount: true,
      track: { select: { title: true } },
      artist: { select: { name: true } },
    },
  });

  const data: RunTrackTotalDto[] = rows.map((r) => ({
    trackId: r.trackId,
    trackTitle: r.track.title,
    artistId: r.artistId,
    artistName: r.artist.name,
    eligibleStreams: Number(r.eligibleStreams),
    allocationPercentage: String(r.allocationPercentage),
    grossAmount: fmt(toMinor(r.grossAmount)),
    currency: run.currency,
  }));
  return pageEnvelope(data, total, p);
}

/** Period detail with revenue inputs and runs. */
export async function getPeriod(periodId: string, deps: RoyaltyDeps): Promise<PeriodDetailDto> {
  const { db } = deps;
  const period = await db.royaltyPeriod.findUnique({
    where: { id: periodId },
    select: {
      id: true,
      periodStart: true,
      periodEnd: true,
      status: true,
      currency: true,
      revenueInputs: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          source: true,
          currency: true,
          grossAmount: true,
          deductions: true,
          netAmount: true,
          referenceId: true,
        },
      },
      runs: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          runKey: true,
          periodId: true,
          status: true,
          totalEligibleStreams: true,
          royaltyPool: true,
          totalAllocated: true,
          residualAmount: true,
          currency: true,
          startedAt: true,
          completedAt: true,
          error: true,
          createdAt: true,
          policy: { select: { version: true, name: true } },
          period: { select: { periodStart: true, periodEnd: true } },
          _count: { select: { earnings: true } },
        },
      },
    },
  });
  if (!period) throw notFound('Royalty period not found.');

  let netTotal = 0n;
  const revenueInputs = period.revenueInputs.map((r) => {
    netTotal += toMinor(r.netAmount);
    return {
      id: r.id,
      source: r.source,
      currency: r.currency,
      grossAmount: fmt(toMinor(r.grossAmount)),
      deductions: fmt(toMinor(r.deductions)),
      netAmount: fmt(toMinor(r.netAmount)),
      referenceId: r.referenceId,
    };
  });

  const runs: AdminRunDto[] = [];
  for (const r of period.runs) {
    const artists = await db.royaltyEarning.groupBy({ by: ['artistId'], where: { runId: r.id } });
    runs.push(toAdminRunDto(r, artists.length));
  }

  return {
    periodId: period.id,
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    status: period.status,
    currency: period.currency,
    revenueInputs,
    totalNetRevenue: fmt(netTotal),
    runs,
  };
}
