// Phase 21 — Royalty Engine. Deterministic allocation calculation.
//
// Calculation (all in integer minor units, BigInt — never float):
//
//   netRevenue      = Σ revenue inputs (gross − deductions), per currency
//   pool            = round_half_up(netRevenue × artistPoolPercentage / 100)
//   per-track exact = pool × trackStreams / totalStreams
//   per-track line  = round_half_up(exact)              [policy rounding_mode]
//   excess          = Σ lines − pool                     [>= 0 possible]
//   if excess > 0: subtract cents from the largest lines first
//                   (deterministic: allocation desc, trackId asc), never below 0
//   residual        = pool − Σ final lines                [always >= 0]
//
// Guarantees:
// - Same inputs + same policy version = same results (inputs sorted by
//   trackId; all arithmetic exact).
// - Σ allocations + residual = pool exactly (reconciliation invariant).
// - Allocations never exceed the pool; no money is created by rounding.
// - Tracks below the policy minimum_streams are excluded before this step.

import { divRoundHalfUp, pctOf } from './money.js';
import type { TrackStreamCount } from './eligibility.js';

export interface CalculationInput {
  /** Net revenue in minor units (BigInt). Must be >= 0. */
  netRevenueMinor: bigint;
  /** Artist pool percentage as a decimal string, e.g. "70.00". */
  artistPoolPercentage: string;
  /** Eligible per-track streams, sorted by trackId ascending. */
  tracks: TrackStreamCount[];
  /** Currency code (informational; single-currency per run). */
  currency: string;
}

export interface AllocationLine {
  trackId: string;
  artistId: string;
  eligibleStreams: number;
  /** Track's share of total streams as a percentage string (6 dp). */
  allocationPercentage: string;
  /** Gross allocated amount in minor units. */
  grossMinor: bigint;
}

export interface CalculationResult {
  /** Royalty pool in minor units. */
  poolMinor: bigint;
  /** Per-track allocation lines (same order as input). */
  lines: AllocationLine[];
  /** Sum of line amounts in minor units. */
  totalAllocatedMinor: bigint;
  /** Explicit residual: pool − totalAllocated, always >= 0. */
  residualMinor: bigint;
  totalStreams: number;
  currency: string;
}

/**
 * Format a track's share as a percentage string with 6 decimal places.
 * E.g., 1/3 -> "33.333333". Pure integer math.
 */
function sharePct(trackStreams: number, totalStreams: number): string {
  // pct = streams/total*100 with 6 dp = streams*100*10^6/total, rounded half up
  const scaled = divRoundHalfUp(BigInt(trackStreams) * 100_000_000n, BigInt(totalStreams));
  const whole = scaled / 1_000_000n;
  const frac = (scaled % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${frac}`;
}

export function calculateRoyalties(input: CalculationInput): CalculationResult {
  const { netRevenueMinor, artistPoolPercentage, tracks, currency } = input;
  if (netRevenueMinor < 0n) throw new Error('netRevenueMinor must be >= 0');
  if (tracks.some((t) => t.streams < 0)) throw new Error('stream counts must be >= 0');

  const totalStreams = tracks.reduce((s, t) => s + t.streams, 0);

  // Royalty pool: net revenue × pool percentage, rounded half up.
  const poolMinor = pctOf(netRevenueMinor, artistPoolPercentage);

  if (totalStreams === 0 || poolMinor === 0n) {
    // Nothing to allocate: the entire pool is explicit residual.
    return {
      poolMinor,
      lines: tracks.map((t) => ({
        trackId: t.trackId,
        artistId: t.artistId,
        eligibleStreams: t.streams,
        allocationPercentage: '0.000000',
        grossMinor: 0n,
      })),
      totalAllocatedMinor: 0n,
      residualMinor: poolMinor,
      totalStreams,
      currency,
    };
  }

  const total = BigInt(totalStreams);
  // Step 1: half-up per-line rounding of the exact share.
  const rounded: AllocationLine[] = tracks.map((t) => ({
    trackId: t.trackId,
    artistId: t.artistId,
    eligibleStreams: t.streams,
    allocationPercentage: sharePct(t.streams, totalStreams),
    grossMinor: divRoundHalfUp(poolMinor * BigInt(t.streams), total),
  }));

  // Step 2: if half-up rounding overshot the pool, claw back cents from
  // the largest lines first (deterministic order), never below zero.
  let allocated = rounded.reduce((s, l) => s + l.grossMinor, 0n);
  if (allocated > poolMinor) {
    let excess = allocated - poolMinor;
    const order = [...rounded].sort((a, b) => {
      if (b.grossMinor !== a.grossMinor) return b.grossMinor < a.grossMinor ? -1 : 1;
      return a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0;
    });
    for (const line of order) {
      if (excess === 0n) break;
      const take = line.grossMinor < excess ? line.grossMinor : excess;
      line.grossMinor -= take;
      excess -= take;
    }
    allocated = rounded.reduce((s, l) => s + l.grossMinor, 0n);
  }

  const residualMinor = poolMinor - allocated;
  if (residualMinor < 0n) throw new Error('Invariant violated: allocations exceed pool');

  return {
    poolMinor,
    lines: rounded,
    totalAllocatedMinor: allocated,
    residualMinor,
    totalStreams,
    currency,
  };
}
