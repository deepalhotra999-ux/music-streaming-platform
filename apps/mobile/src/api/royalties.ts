// Phase 21 — Royalty Engine. Artist royalty API wrappers.
//
// Thin wrappers over the Phase 21 royalty endpoints. Every call requires
// an authenticated client; the backend enforces ARTIST/ADMIN roles plus
// artist ownership (canManageArtist) and computes all amounts server-side
// — the client never computes earnings.

import type { ApiClient } from './client';
import type { Page } from './types';

export interface RoyaltyLatestPeriod {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  earnings: string;
  streams: number;
  runId: string;
  policyVersion: number;
}

export interface RoyaltyOverview {
  artistId: string;
  currency: string;
  totalEarnings: string;
  totalStreams: number;
  completedPeriods: number;
  latestPeriod: RoyaltyLatestPeriod | null;
}

export interface RoyaltyPeriodItem {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  status: 'OPEN' | 'CALCULATING' | 'COMPLETED' | 'FAILED';
  currency: string;
  earnings: string;
  streams: number;
  runId: string | null;
  policyVersion: number | null;
}

export interface RoyaltyTrackEarning {
  trackId: string;
  title: string;
  eligibleStreams: number;
  allocationPercentage: string;
  grossAmount: string;
  adjustmentsTotal: string;
  finalAmount: string;
  currency: string;
}

export interface RoyaltyRun {
  runId: string;
  periodId: string;
  periodStart: string;
  periodEnd: string;
  policyVersion: number;
  policyName: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  currency: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  artistEarnings: string;
  artistStreams: number;
  artistTrackCount: number;
}

export async function getRoyaltyOverview(
  client: ApiClient,
  artistId: string,
): Promise<RoyaltyOverview> {
  return client.get<RoyaltyOverview>(`/v1/artists/${artistId}/royalties/overview`);
}

export async function getRoyaltyPeriods(
  client: ApiClient,
  artistId: string,
  page?: number,
  limit?: number,
): Promise<Page<RoyaltyPeriodItem>> {
  const params = new URLSearchParams();
  if (page !== undefined) params.set('page', String(page));
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  return client.get<Page<RoyaltyPeriodItem>>(
    `/v1/artists/${artistId}/royalties/periods${qs ? `?${qs}` : ''}`,
  );
}

export async function getRoyaltyPeriodTracks(
  client: ApiClient,
  artistId: string,
  periodId: string,
  page?: number,
  limit?: number,
): Promise<Page<RoyaltyTrackEarning>> {
  const params = new URLSearchParams();
  if (page !== undefined) params.set('page', String(page));
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  return client.get<Page<RoyaltyTrackEarning>>(
    `/v1/artists/${artistId}/royalties/periods/${periodId}/tracks${qs ? `?${qs}` : ''}`,
  );
}

export async function getRoyaltyRun(
  client: ApiClient,
  artistId: string,
  runId: string,
): Promise<RoyaltyRun> {
  return client.get<RoyaltyRun>(`/v1/artists/${artistId}/royalties/runs/${runId}`);
}

/** Format a major-unit decimal string as a currency amount. */
export function formatMoney(amount: string, currency: string): string {
  // Format exact decimal strings without Number conversion (preserves precision).
  // Expected format: "1234.56" or "1234" — normalize to 2 decimal places.
  const match = /^(-?\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) return `${amount} ${currency}`;
  const [, intPart, fracPart = ''] = match;
  const frac = (fracPart + '00').slice(0, 2);
  return `${currency} ${intPart}.${frac}`;
}
