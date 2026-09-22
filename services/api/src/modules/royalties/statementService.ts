// Phase 22 — Royalty Transparency. Artist statement service.
//
// Server-generated royalty statements for individual artists and periods.
// Read-only against Phase 21 accounting records — no mutations.
//
// Privacy: statements expose only the requesting artist's data plus the
// platform aggregates explicitly needed to verify the calculation
// (total eligible streams, royalty pool). Internal run keys, revenue
// hashes, and other artists' data are never exposed.

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
): Promise<{ id: string; name: string }> {
  const artist = await db.artist.findFirst({
    where: { id: artistId, deletedAt: null },
    select: { id: true, name: true, ownerUserId: true },
  });
  if (!artist) throw notFound('Artist not found.');
  if (!canManageArtist(actor, artist)) {
    throw forbidden('You can only view royalty statements for artists you own.');
  }
  return { id: artist.id, name: artist.name };
}

// --- Safe policy DTO ---

export interface ArtistPolicyDto {
  version: number;
  name: string;
  effectiveFrom: string;
  /** Human-readable stream eligibility rule. */
  streamEligibilityRule: string;
  /** Human-readable allocation methodology. */
  allocationMethodology: string;
  /** Human-readable rounding methodology. */
  roundingMethodology: string;
  /**
   * Whether this policy uses placeholder/test values.
   * Always true for Phase 22 — production values must be configured before launch.
   */
  isTestPolicy: boolean;
  /** Minimum streams threshold, if configured. */
  minimumStreams: number | null;
}

function toArtistPolicyDto(p: {
  version: number;
  name: string;
  effectiveFrom: Date;
  minimumStreams: number | null;
}): ArtistPolicyDto {
  const threshold = p.minimumStreams ?? 0;
  return {
    version: p.version,
    name: p.name,
    effectiveFrom: p.effectiveFrom.toISOString(),
    streamEligibilityRule:
      threshold > 0
        ? `A playback session counts as one eligible stream when it contains at least one completed play. Artists with fewer than ${threshold} eligible streams in the period are excluded from allocation.`
        : 'A playback session counts as one eligible stream when it contains at least one completed play. Duplicate completions in the same session count once. Failed or incomplete sessions do not count.',
    allocationMethodology:
      'Earnings are allocated proportionally: each artist receives a share of the royalty pool equal to their share of total eligible streams in the period.',
    roundingMethodology:
      'Amounts are calculated in cents using integer arithmetic. Fractional cents are rounded half up per allocation line; any unallocated remainder is retained as a rounding residual.',
    isTestPolicy: true,
    minimumStreams: p.minimumStreams,
  };
}

// --- Statement ---

export type StatementStatus = 'COMPLETED' | 'PENDING' | 'RUNNING' | 'FAILED';

export interface CalculationStep {
  label: string;
  value: string;
  explanation: string;
}

export interface ArtistStatementDto {
  /** Safe artist-facing reference (NOT the internal run key). */
  statementReference: string;
  artistId: string;
  artistName: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  status: StatementStatus;
  /** When the calculation completed, null if not completed. */
  finalizedAt: string | null;
  policy: ArtistPolicyDto | null;
  // Streams
  eligibleStreams: number;
  totalEligibleStreams: number;
  /** Exact share percentage as a decimal string (e.g., "6.5432"). */
  artistSharePercentage: string;
  // Money (major-unit decimal strings)
  royaltyPool: string;
  artistAllocation: string;
  adjustmentsTotal: string;
  /** Platform rounding residual (informational). */
  residualAmount: string;
  finalEarnings: string;
  // Explainable calculation (exact values from records)
  calculation: CalculationStep[];
}

/**
 * Generate a safe, deterministic statement reference.
 * Format: STMT-YYYYMM-<artistId prefix>. Not reversible to internal keys.
 */
export function statementReference(periodStart: Date, artistId: string): string {
  const ym = `${periodStart.getUTCFullYear()}${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
  const suffix = artistId.replace(/-/g, '').slice(0, 6).toUpperCase();
  return `STMT-${ym}-${suffix}`;
}

/**
 * Artist royalty statement for a period. Read-only.
 *
 * Status mapping:
 * - Period COMPLETED with a COMPLETED run → COMPLETED (finalized earnings)
 * - Period CALCULATING or run PENDING/RUNNING → RUNNING (not finalized)
 * - Period OPEN with no run → PENDING (not finalized)
 * - Period FAILED or run FAILED → FAILED (not finalized)
 *
 * Incomplete calculations never present earnings as finalized.
 */
export async function getArtistStatement(
  artistId: string,
  periodId: string,
  actor: AuthUser,
  deps: RoyaltyDeps,
): Promise<ArtistStatementDto> {
  const { db } = deps;
  const artist = await requireRoyaltyArtist(db, artistId, actor);

  const period = await db.royaltyPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Royalty period not found.');

  const run = await db.royaltyCalculationRun.findFirst({
    where: { periodId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      totalEligibleStreams: true,
      royaltyPool: true,
      totalAllocated: true,
      residualAmount: true,
      currency: true,
      completedAt: true,
      policy: {
        select: { version: true, name: true, effectiveFrom: true, minimumStreams: true },
      },
    },
  });

  const ref = statementReference(period.periodStart, artistId);
  const base = {
    statementReference: ref,
    artistId: artist.id,
    artistName: artist.name,
    periodId: period.id,
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    currency: period.currency,
  };

  // Determine statement status from period + run.
  let status: StatementStatus;
  if (period.status === 'FAILED' || run?.status === 'FAILED') {
    status = 'FAILED';
  } else if (period.status === 'COMPLETED' && run?.status === 'COMPLETED') {
    status = 'COMPLETED';
  } else if (
    period.status === 'CALCULATING' ||
    run?.status === 'PENDING' ||
    run?.status === 'RUNNING'
  ) {
    status = 'RUNNING';
  } else {
    status = 'PENDING';
  }

  // Non-completed: return shell without financial values.
  if (status !== 'COMPLETED' || !run) {
    return {
      ...base,
      status,
      finalizedAt: null,
      policy: run ? toArtistPolicyDto(run.policy) : null,
      eligibleStreams: 0,
      totalEligibleStreams: 0,
      artistSharePercentage: '0',
      royaltyPool: fmt(0n),
      artistAllocation: fmt(0n),
      adjustmentsTotal: fmt(0n),
      residualAmount: fmt(0n),
      finalEarnings: fmt(0n),
      calculation: [],
    };
  }

  // Completed: aggregate the artist's earnings in this run.
  const earnings = await db.royaltyEarning.findMany({
    where: { runId: run.id, artistId },
    select: {
      eligibleStreams: true,
      grossAmount: true,
      adjustmentsTotal: true,
      finalAmount: true,
    },
  });

  let artistStreams = 0;
  let allocation = 0n;
  let adjustments = 0n;
  let final = 0n;
  for (const e of earnings) {
    artistStreams += Number(e.eligibleStreams);
    allocation += decToMinor(e.grossAmount);
    adjustments += decToMinor(e.adjustmentsTotal);
    final += decToMinor(e.finalAmount);
  }

  const totalStreams = Number(run.totalEligibleStreams);
  const pool = decToMinor(run.royaltyPool);
  const residual = decToMinor(run.residualAmount);

  // Share percentage: exact to 4 decimal places using integer math.
  // share = artistStreams * 100 / totalStreams
  let sharePct = '0';
  if (totalStreams > 0 && artistStreams > 0) {
    // Compute with 6 decimal digits of precision: (streams * 100 * 1e6) / total
    const scaled = (BigInt(artistStreams) * 100_000000n) / BigInt(totalStreams);
    const whole = scaled / 1_000000n;
    const frac = (scaled % 1_000000n).toString().padStart(6, '0').replace(/0+$/, '') || '0';
    sharePct = frac === '0' ? whole.toString() : `${whole}.${frac}`;
  }

  const policy = toArtistPolicyDto(run.policy);

  // Explainable calculation steps — exact values from records, no invented numbers.
  const calculation: CalculationStep[] = [
    {
      label: 'Your eligible streams',
      value: artistStreams.toLocaleString(),
      explanation:
        'Playback sessions with at least one completed play in this period. Duplicate completions count once.',
    },
    {
      label: 'Total eligible streams',
      value: totalStreams.toLocaleString(),
      explanation: 'All eligible streams across all artists in this period.',
    },
    {
      label: 'Your share',
      value: `${sharePct}%`,
      explanation: `Your ${artistStreams.toLocaleString()} streams ÷ ${totalStreams.toLocaleString()} total streams.`,
    },
    {
      label: 'Royalty pool',
      value: fmt(pool),
      explanation:
        'The portion of verified period revenue allocated to artists under this policy version.',
    },
    {
      label: 'Your allocation',
      value: fmt(allocation),
      explanation: `Royalty pool × your share, calculated per track in cents and summed.`,
    },
  ];
  if (adjustments !== 0n) {
    calculation.push({
      label: 'Adjustments',
      value: fmt(adjustments),
      explanation: 'Manual corrections recorded against this statement.',
    });
  }
  calculation.push({
    label: 'Rounding residual (platform)',
    value: fmt(residual),
    explanation:
      'Unallocated remainder from integer-cent division across all artists. Retained by the platform; does not reduce your allocation.',
  });
  calculation.push({
    label: 'Your final earnings',
    value: fmt(final),
    explanation: 'Your allocation plus adjustments. This is the finalized amount for this period.',
  });

  return {
    ...base,
    status,
    finalizedAt: run.completedAt?.toISOString() ?? null,
    policy,
    eligibleStreams: artistStreams,
    totalEligibleStreams: totalStreams,
    artistSharePercentage: sharePct,
    royaltyPool: fmt(pool),
    artistAllocation: fmt(allocation),
    adjustmentsTotal: fmt(adjustments),
    residualAmount: fmt(residual),
    finalEarnings: fmt(final),
    calculation,
  };
}

// --- Track-level transparency ---

export interface StatementTrackDto {
  trackId: string;
  title: string;
  eligibleStreams: number;
  /** Share of the artist's own streams, as a decimal string percentage. */
  shareOfArtistStreams: string;
  grossAmount: string;
  adjustmentsTotal: string;
  finalAmount: string;
  currency: string;
}

/**
 * Per-track breakdown for an artist's statement in a completed period.
 * Sorted by finalAmount desc (or by eligibleStreams desc); paginated.
 */
export async function getStatementTracks(
  artistId: string,
  periodId: string,
  actor: AuthUser,
  query: PaginationQuery & { sort?: string },
  deps: RoyaltyDeps,
): Promise<PageEnvelope<StatementTrackDto>> {
  const { db } = deps;
  await requireRoyaltyArtist(db, artistId, actor);

  const period = await db.royaltyPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Royalty period not found.');

  const p = parsePagination(query);
  const run = await db.royaltyCalculationRun.findFirst({
    where: { periodId, status: 'COMPLETED' },
    select: { id: true },
  });
  if (!run) return pageEnvelope([], 0, p);

  const where = { runId: run.id, artistId };
  const total = await db.royaltyEarning.count({ where });

  const sort = query.sort === 'streams' ? 'streams' : 'earnings';
  const orderBy =
    sort === 'streams'
      ? [{ eligibleStreams: 'desc' as const }, { trackId: 'asc' as const }]
      : [{ finalAmount: 'desc' as const }, { trackId: 'asc' as const }];

  const rows = await db.royaltyEarning.findMany({
    where,
    orderBy,
    skip: p.skip,
    take: p.limit,
    select: {
      trackId: true,
      eligibleStreams: true,
      grossAmount: true,
      adjustmentsTotal: true,
      finalAmount: true,
      currency: true,
      track: { select: { title: true } },
    },
  });

  // Artist's total streams in this run (for per-track share).
  const artistTotal = await db.royaltyEarning.aggregate({
    where,
    _sum: { eligibleStreams: true },
  });
  const artistStreams = Number(artistTotal._sum.eligibleStreams ?? 0n);

  const data: StatementTrackDto[] = rows.map((r) => {
    const streams = Number(r.eligibleStreams);
    let share = '0';
    if (artistStreams > 0 && streams > 0) {
      const scaled = (BigInt(streams) * 100_000000n) / BigInt(artistStreams);
      const whole = scaled / 1_000000n;
      const frac = (scaled % 1_000000n).toString().padStart(6, '0').replace(/0+$/, '') || '0';
      share = frac === '0' ? whole.toString() : `${whole}.${frac}`;
    }
    return {
      trackId: r.trackId,
      title: r.track.title,
      eligibleStreams: streams,
      shareOfArtistStreams: share,
      grossAmount: fmt(decToMinor(r.grossAmount)),
      adjustmentsTotal: fmt(decToMinor(r.adjustmentsTotal)),
      finalAmount: fmt(decToMinor(r.finalAmount)),
      currency: r.currency,
    };
  });
  return pageEnvelope(data, total, p);
}

// --- CSV export ---

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Server-generated CSV statement for a completed period.
 * Uses the same Phase 21 records as the JSON statement — no recalculation.
 * Only information the artist is authorized to see.
 */
export async function getStatementCsv(
  artistId: string,
  periodId: string,
  actor: AuthUser,
  deps: RoyaltyDeps,
): Promise<{ filename: string; csv: string }> {
  const statement = await getArtistStatement(artistId, periodId, actor, deps);
  if (statement.status !== 'COMPLETED') {
    throw notFound('Statement is not available for this period yet.');
  }

  // Fetch all tracks (unpaginated for export).
  const { db } = deps;
  const run = await db.royaltyCalculationRun.findFirst({
    where: { periodId, status: 'COMPLETED' },
    select: { id: true },
  });
  const rows = run
    ? await db.royaltyEarning.findMany({
        where: { runId: run.id, artistId },
        orderBy: [{ finalAmount: 'desc' }, { trackId: 'asc' }],
        select: {
          track: { select: { title: true } },
          eligibleStreams: true,
          allocationPercentage: true,
          grossAmount: true,
          adjustmentsTotal: true,
          finalAmount: true,
          currency: true,
        },
      })
    : [];

  const lines: string[] = [];
  lines.push('Royalty Statement');
  lines.push(`Statement Reference,${csvCell(statement.statementReference)}`);
  lines.push(`Artist,${csvCell(statement.artistName)}`);
  lines.push(`Period,${csvCell(statement.periodStart)} to ${csvCell(statement.periodEnd)}`);
  lines.push(`Currency,${csvCell(statement.currency)}`);
  lines.push(`Policy Version,${csvCell(statement.policy?.version ?? '')}`);
  lines.push(`Policy Name,${csvCell(statement.policy?.name ?? '')}`);
  lines.push(`Status,${csvCell(statement.status)}`);
  lines.push(`Finalized At,${csvCell(statement.finalizedAt ?? '')}`);
  lines.push('');
  lines.push('Summary');
  lines.push(`Your Eligible Streams,${statement.eligibleStreams}`);
  lines.push(`Total Eligible Streams,${statement.totalEligibleStreams}`);
  lines.push(`Your Share %,${csvCell(statement.artistSharePercentage)}`);
  lines.push(`Royalty Pool,${csvCell(statement.royaltyPool)}`);
  lines.push(`Your Allocation,${csvCell(statement.artistAllocation)}`);
  lines.push(`Adjustments,${csvCell(statement.adjustmentsTotal)}`);
  lines.push(`Final Earnings,${csvCell(statement.finalEarnings)}`);
  lines.push('');
  lines.push('Calculation');
  lines.push('Step,Value,Explanation');
  for (const s of statement.calculation) {
    lines.push(`${csvCell(s.label)},${csvCell(s.value)},${csvCell(s.explanation)}`);
  }
  lines.push('');
  lines.push('Tracks');
  lines.push('Title,Eligible Streams,Allocation %,Gross Amount,Adjustments,Final Amount,Currency');
  for (const r of rows) {
    lines.push(
      [
        csvCell(r.track.title),
        r.eligibleStreams.toString(),
        csvCell(String(r.allocationPercentage)),
        csvCell(fmt(decToMinor(r.grossAmount))),
        csvCell(fmt(decToMinor(r.adjustmentsTotal))),
        csvCell(fmt(decToMinor(r.finalAmount))),
        csvCell(r.currency),
      ].join(','),
    );
  }

  const filename = `${statement.statementReference}.csv`;
  return { filename, csv: lines.join('\n') + '\n' };
}
