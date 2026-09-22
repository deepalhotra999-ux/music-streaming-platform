// Phase 21 — Royalty Engine. Calculation run orchestration.
//
// A run is idempotent and transactional:
// - runKey = `period:<periodId>:policy:v<version>:rev:<revenueHash>` where
//   revenueHash is a SHA-256 over the sorted revenue inputs. Retrying with
//   identical inputs returns the existing run; changed inputs produce a new
//   runKey (which will conflict with the one-COMPLETED-run-per-period
//   constraint unless the previous run failed).
// - All writes happen in a single transaction: run row (RUNNING) ->
//   earnings lines -> run row (COMPLETED) + period (COMPLETED).
// - A second concurrent attempt blocks on the runKey unique constraint and
//   returns the existing run instead of double-counting.

import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getEligibleStreams } from './eligibility.js';
import { calculateRoyalties } from './calculation.js';
import { toMinorUnits, toNumericString, fromMinorUnits } from './money.js';
import { badRequest, conflict, notFound } from '../../http/errors.js';

export interface RoyaltyDeps {
  db: PrismaClient;
}

interface RevenueInputRow {
  id: string;
  source: string;
  currency: string;
  grossAmount: unknown;
  deductions: unknown;
  netAmount: unknown;
  referenceId: string;
}

/** Deterministic hash over the sorted revenue inputs. */
function revenueHash(inputs: RevenueInputRow[]): string {
  const canonical = inputs
    .map(
      (r) =>
        `${r.referenceId}:${r.source}:${r.currency}:${String(r.grossAmount)}:${String(r.deductions)}:${String(r.netAmount)}`,
    )
    .sort()
    .join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

function decimalToString(v: unknown): string {
  // Prisma Decimal has toString(); be defensive.
  if (v !== null && typeof v === 'object' && 'toString' in v) return String(v);
  return String(v);
}

export interface RunCalculationResult {
  runId: string;
  runKey: string;
  status: string;
  duplicate: boolean;
}

/**
 * Execute (or return the existing) royalty calculation for a period.
 * Idempotent on runKey. Throws on invalid state (period already COMPLETED
 * with a different runKey, currency mismatch, no ACTIVE policy, etc.).
 */
export async function runRoyaltyCalculation(
  periodId: string,
  actorId: string | null,
  deps: RoyaltyDeps,
): Promise<RunCalculationResult> {
  const { db } = deps;

  const period = await db.royaltyPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw notFound('Royalty period not found.');

  const policy = await db.royaltyPolicy.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { version: 'desc' },
  });
  if (!policy) throw badRequest('No ACTIVE royalty policy. Create and activate a policy first.');

  const inputs = (await db.royaltyRevenueInput.findMany({
    where: { periodId },
    orderBy: { referenceId: 'asc' },
  })) as unknown as RevenueInputRow[];
  if (inputs.length === 0) {
    throw badRequest('Period has no revenue inputs. Record revenue before calculating.');
  }

  // Single-currency scope: all inputs must share the period currency.
  const badCurrency = inputs.find((r) => r.currency !== period.currency);
  if (badCurrency) {
    throw badRequest(
      `Unsupported currency input: ${badCurrency.currency} (reference ${badCurrency.referenceId}). ` +
        `Period currency is ${period.currency}. Multi-currency allocation is not supported; ` +
        `record inputs in the period currency or create a separate period.`,
    );
  }
  if (policy.currency !== period.currency) {
    throw badRequest(
      `Policy currency ${policy.currency} does not match period currency ${period.currency}.`,
    );
  }

  const revHash = revenueHash(inputs);
  const runKey = `period:${periodId}:policy:v${policy.version}:rev:${revHash}`;

  // Idempotency: return the existing run if this exact calculation was requested
  // before — even if the period is already COMPLETED. This makes retries safe.
  const existing = await db.royaltyCalculationRun.findUnique({ where: { runKey } });
  if (existing) {
    return { runId: existing.id, runKey, status: existing.status, duplicate: true };
  }

  // No matching run: a COMPLETED period cannot be recalculated with different inputs.
  if (period.status === 'COMPLETED') {
    throw conflict(
      'Period already has a completed calculation. Recalculation requires a new period.',
    );
  }
  if (period.status !== 'OPEN') {
    throw conflict(`Period is not open for calculation (status: ${period.status}).`);
  }

  // Sum net revenue in minor units (exact).
  let netMinor = 0n;
  for (const r of inputs) {
    const net = toMinorUnits(decimalToString(r.netAmount));
    const gross = toMinorUnits(decimalToString(r.grossAmount));
    const ded = toMinorUnits(decimalToString(r.deductions));
    if (net !== gross - ded) {
      throw badRequest(
        `Revenue input ${r.referenceId} is inconsistent: net != gross - deductions.`,
      );
    }
    if (net < 0n) throw badRequest(`Revenue input ${r.referenceId} has negative net amount.`);
    netMinor += net;
  }

  // Eligible streams (Phase 15 semantics + policy minimum).
  const eligible = await getEligibleStreams(
    db,
    period.periodStart,
    period.periodEnd,
    policy.minimumStreams,
  );

  // Deterministic calculation (pure function of inputs + policy).
  const calc = calculateRoyalties({
    netRevenueMinor: netMinor,
    artistPoolPercentage: decimalToString(policy.artistPoolPercentage),
    tracks: eligible.tracks,
    currency: period.currency,
  });

  // Revenue snapshot for audit/reproducibility.
  const revenueSnapshot = {
    inputs: inputs.map((r) => ({
      referenceId: r.referenceId,
      source: r.source,
      currency: r.currency,
      grossAmount: decimalToString(r.grossAmount),
      deductions: decimalToString(r.deductions),
      netAmount: decimalToString(r.netAmount),
    })),
    revenueHash: revHash,
    rawCompletedSessions: eligible.rawCompletedSessions,
    policyVersion: policy.version,
    policyName: policy.name,
    artistPoolPercentage: decimalToString(policy.artistPoolPercentage),
    minimumStreams: policy.minimumStreams,
    roundingMode: policy.roundingMode,
  };

  // Mark period as CALCULATING before the transaction (OPEN → CALCULATING
  // is the only allowed transition out of OPEN). If this fails, another
  // calculation is already in flight or the period is closed.
  try {
    await db.royaltyPeriod.update({
      where: { id: periodId, status: 'OPEN' },
      data: { status: 'CALCULATING' },
    });
  } catch {
    throw conflict(
      'Period is not open for calculation (already calculating, completed, or failed).',
    );
  }

  // Transactional write: run -> lines -> completed run + completed period.
  // Unique constraints (runKey; one COMPLETED per period; per-line identity)
  // make concurrent/duplicate attempts fail safe. On failure the period is
  // moved to FAILED so it can be inspected/retried, never left stuck.
  try {
    const run = await db.$transaction(async (tx) => {
      const created = await tx.royaltyCalculationRun.create({
        data: {
          periodId,
          policyId: policy.id,
          status: 'RUNNING',
          runKey,
          revenueSnapshot,
          totalEligibleStreams: BigInt(eligible.totalStreams),
          royaltyPool: toNumericString(calc.poolMinor),
          totalAllocated: toNumericString(calc.totalAllocatedMinor),
          residualAmount: toNumericString(calc.residualMinor),
          currency: period.currency,
          startedAt: new Date(),
          createdBy: actorId,
        },
      });

      if (calc.lines.length > 0) {
        await tx.royaltyEarning.createMany({
          data: calc.lines.map((l) => ({
            runId: created.id,
            artistId: l.artistId,
            trackId: l.trackId,
            eligibleStreams: BigInt(l.eligibleStreams),
            allocationPercentage: l.allocationPercentage,
            grossAmount: toNumericString(l.grossMinor),
            adjustmentsTotal: toNumericString(0n),
            finalAmount: toNumericString(l.grossMinor),
            currency: period.currency,
          })),
        });
      }

      // Audit snapshot: the exact playback sessions counted as eligible streams.
      // Append-only; links each earning back to the listening activity.
      if (eligible.sessions.length > 0) {
        await tx.royaltyEligibleStream.createMany({
          data: eligible.sessions.map((s) => ({
            runId: created.id,
            playbackSessionId: s.sessionId,
            trackId: s.trackId,
            artistId: s.artistId,
            sessionCreatedAt: s.sessionCreatedAt,
          })),
        });
      }

      const completed = await tx.royaltyCalculationRun.update({
        where: { id: created.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      // CALCULATING → COMPLETED is the allowed terminal transition.
      await tx.royaltyPeriod.update({
        where: { id: periodId },
        data: { status: 'COMPLETED' },
      });
      return completed;
    });

    return { runId: run.id, runKey, status: run.status, duplicate: false };
  } catch (err) {
    // Never leave the period stuck in CALCULATING: move it to FAILED so the
    // failure is visible and the period can be investigated. The run row (if
    // created) stays for audit; a retry uses a new runKey only if inputs change.
    await db.royaltyPeriod
      .update({
        where: { id: periodId, status: 'CALCULATING' },
        data: { status: 'FAILED' },
      })
      .catch(() => {});
    throw err;
  }
}

/** Mark a run FAILED with an error message (used when the transaction throws). */
export async function failRoyaltyRun(
  runId: string,
  error: string,
  deps: RoyaltyDeps,
): Promise<void> {
  await deps.db.royaltyCalculationRun.update({
    where: { id: runId },
    data: { status: 'FAILED', error: error.slice(0, 2000), completedAt: new Date() },
  });
}

export { fromMinorUnits };
