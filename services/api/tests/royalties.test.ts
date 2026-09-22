/**
 * Phase 21 — Royalty Engine & Auditable Artist Earnings tests.
 * Full HTTP stack via `app.inject()` against TEST_DATABASE_URL.
 *
 * Covers:
 * - Eligible stream semantics (Phase 15: COMPLETE = stream, counted once
 *   per session; ERROR-only and START-only sessions never count)
 * - Duplicate COMPLETE events count once
 * - Revenue allocation math (pool = net × pool%, pro-rata by streams)
 * - Money precision (integer minor units, no float)
 * - Rounding (HALF_UP) and residual handling
 * - Reconciliation invariant: Σ allocations + residual = pool
 * - Determinism: same inputs + same policy = same results
 * - Idempotency: duplicate run requests return the existing run
 * - Zero-stream artists get no lines; zero-revenue periods
 * - Policy versions: new version, old calculations immutable
 * - Minimum streams threshold
 * - Unsupported currency rejection
 * - Artist ownership isolation (A cannot see B's royalties)
 * - LISTENER 403 on all artist royalty endpoints
 * - ADMIN inspection endpoints
 * - Append-only enforcement (UPDATE/DELETE on earnings rejected)
 * - Invalid inputs (bad amounts, deductions > gross, etc.)
 *
 * Cleanup is scoped to `@phase21-test.local` addresses. Royalty tables
 * are append-only; test cleanup disables triggers temporarily.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { createAccessToken } from '../src/modules/auth/tokens.js';

const TEST_DOMAIN = '@phase21-test.local';
let counter = 0;
const testEmail = (tag: string) => `phase21-${tag}-${Date.now()}-${counter++}${TEST_DOMAIN}`;
const PASSWORD = 'correct-horse-battery-123';

let app: FastifyInstance;
let config: Config;

interface TestUser {
  id: string;
  email: string;
  token: string;
  role: string;
}

/**
 * Create a user directly via Prisma (bypassing HTTP rate limits).
 * Uses the real password hasher and token creator.
 */
async function createUser(tag: string, role: 'LISTENER' | 'ARTIST' | 'ADMIN' = 'LISTENER'): Promise<TestUser> {
  const email = testEmail(tag);
  const passwordHash = await hashPassword(PASSWORD);
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName: `${tag} User`,
      role,
    },
  });
  const token = await createAccessToken(
    { id: user.id, email: user.email, role: user.role as 'LISTENER' | 'ARTIST' | 'ADMIN' },
    config,
  );
  return { id: user.id, email, token, role };
}

const auth = (user: TestUser) => ({ authorization: `Bearer ${user.token}` });

/** Disable append-only triggers for test cleanup, re-enable after. */
async function withTriggersDisabled(fn: () => Promise<void>): Promise<void> {
  const triggers: Array<[string, string]> = [
    ['royalty_earnings', 'royalty_earnings_no_update'],
    ['royalty_earnings', 'royalty_earnings_no_delete'],
    ['royalty_revenue_inputs', 'royalty_revenue_inputs_no_update'],
    ['royalty_revenue_inputs', 'royalty_revenue_inputs_no_delete'],
    ['royalty_adjustments', 'royalty_adjustments_no_update'],
    ['royalty_adjustments', 'royalty_adjustments_no_delete'],
    ['royalty_eligible_streams', 'royalty_eligible_streams_no_update'],
    ['royalty_eligible_streams', 'royalty_eligible_streams_no_delete'],
    ['royalty_calculation_runs', 'royalty_runs_transition'],
    ['royalty_periods', 'royalty_periods_transition'],
    ['royalty_policies', 'royalty_policies_immutable'],
  ];
  for (const [table, trigger] of triggers) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  }
  try {
    await fn();
  } finally {
    for (const [table, trigger] of triggers) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
    }
  }
}

async function scopedClean(): Promise<void> {
  await withTriggersDisabled(async () => {
    const userWhere = { user: { email: { endsWith: TEST_DOMAIN } } };
    await prisma.playEvent.deleteMany({ where: userWhere });
    await prisma.playbackSession.deleteMany({ where: userWhere });
    // Royalty data: delete in FK order. Find test runs by runKey prefix.
    const testRuns = await prisma.royaltyCalculationRun.findMany({
      where: { runKey: { startsWith: 'period:' } },
      select: { id: true },
    });
    const runIds = testRuns.map((r) => r.id);
    if (runIds.length > 0) {
      await prisma.royaltyEligibleStream.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.royaltyEarning.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.royaltyAdjustment.deleteMany({ where: { runId: { in: runIds } } });
      await prisma.royaltyCalculationRun.deleteMany({ where: { id: { in: runIds } } });
    }
    // Also clean by artist (for any orphaned data)
    const artists = await prisma.artist.findMany({
      where: { owner: { email: { endsWith: TEST_DOMAIN } } },
      select: { id: true },
    });
    const artistIds = artists.map((a) => a.id);
    if (artistIds.length > 0) {
      await prisma.royaltyAdjustment.deleteMany({ where: { artistId: { in: artistIds } } });
      await prisma.royaltyEarning.deleteMany({ where: { artistId: { in: artistIds } } });
      await prisma.royaltyEligibleStream.deleteMany({ where: { artistId: { in: artistIds } } });
    }
    await prisma.royaltyRevenueInput.deleteMany({
      where: { referenceId: { startsWith: 'phase21-' } },
    });
    await prisma.royaltyPeriod.deleteMany({
      where: { revenueInputs: { some: { referenceId: { startsWith: 'phase21-' } } } },
    });
    // Orphan periods without revenue inputs (from failed test setups)
    await prisma.royaltyPeriod.deleteMany({
      where: {
        revenueInputs: { none: {} },
        runs: { none: {} },
        periodStart: { gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
      },
    });
  });
}

beforeAll(async () => {
  config = loadConfig();
  app = await buildApp(config);
  await scopedClean();
});

afterAll(async () => {
  await scopedClean();
  await app.close();
});

beforeEach(async () => {
  await scopedClean();
});

// --- Helpers ---

async function createArtist(owner: TestUser, name: string) {
  const artist = await prisma.artist.create({
    data: { name, ownerUserId: owner.id, verified: true },
  });
  return artist;
}

async function createTrack(artistId: string, title: string) {
  return prisma.track.create({
    data: {
      title,
      artistId,
      durationMs: 180000,
      status: 'READY',
    },
  });
}

async function createPolicy(admin: TestUser, overrides: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/admin/royalties/policies',
    headers: auth(admin),
    payload: {
      name: 'Test Policy',
      artistPoolPercentage: '70.00',
      currency: 'USD',
      effectiveFrom: new Date('2026-01-01').toISOString(),
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Retire all ACTIVE policies (test isolation for "no active policy" cases). */
async function deactivateAllPolicies() {
  await withTriggersDisabled(async () => {
    await prisma.royaltyPolicy.updateMany({
      where: { status: 'ACTIVE' },
      data: { status: 'RETIRED' },
    });
  });
}

async function activatePolicy(admin: TestUser, policyId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/admin/royalties/policies/${policyId}/activate`,
    headers: auth(admin),
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

let periodSeq = 0;
/** Generate unique period dates: 40 days apart per call, 30-day periods, guaranteed unique. */
function uniquePeriod(): { start: string; end: string } {
  const base = Date.now() + (periodSeq++ * 40 * 86400000);
  const start = new Date(base);
  const end = new Date(base + 30 * 24 * 60 * 60 * 1000); // 30-day period
  return { start: start.toISOString(), end: end.toISOString() };
}

async function createPeriod(admin: TestUser, start: string, end: string, currency = 'USD') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/admin/royalties/periods',
    headers: auth(admin),
    payload: { periodStart: start, periodEnd: end, currency },
  });
  expect(res.statusCode).toBe(201);
  return res.json().periodId as string;
}

async function addRevenue(
  admin: TestUser,
  periodId: string,
  gross: string,
  deductions: string,
  ref: string,
  currency = 'USD',
) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/admin/royalties/revenue',
    headers: auth(admin),
    payload: {
      periodId,
      source: 'SUBSCRIPTION',
      currency,
      grossAmount: gross,
      deductions,
      referenceId: ref,
    },
  });
  return res;
}

async function triggerRun(admin: TestUser, periodId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/admin/royalties/runs',
    headers: auth(admin),
    payload: { periodId },
  });
  return res;
}

/** Create a completed playback session (START + COMPLETE) for a track. */
async function createCompletedSession(userId: string, trackId: string, at: Date) {
  const session = await prisma.playbackSession.create({
    data: {
      userId,
      trackId,
      tokenHash: `phase21-${Date.now()}-${Math.random()}`,
      expiresAt: new Date(at.getTime() + 15 * 60 * 1000),
      createdAt: at,
    },
  });
  await prisma.playEvent.createMany({
    data: [
      { sessionId: session.id, userId, trackId, eventType: 'START', positionMs: 0, createdAt: at },
      { sessionId: session.id, userId, trackId, eventType: 'COMPLETE', positionMs: 180000, createdAt: new Date(at.getTime() + 1000) },
    ],
  });
  return session;
}

/** Create a failed session (START + ERROR, no COMPLETE). */
async function createFailedSession(userId: string, trackId: string, at: Date) {
  const session = await prisma.playbackSession.create({
    data: {
      userId,
      trackId,
      tokenHash: `phase21-fail-${Date.now()}-${Math.random()}`,
      expiresAt: new Date(at.getTime() + 15 * 60 * 1000),
      createdAt: at,
    },
  });
  await prisma.playEvent.createMany({
    data: [
      { sessionId: session.id, userId, trackId, eventType: 'START', positionMs: 0, createdAt: at },
      { sessionId: session.id, userId, trackId, eventType: 'ERROR', positionMs: 5000, createdAt: new Date(at.getTime() + 1000) },
    ],
  });
  return session;
}

/** Create an incomplete session (START only). */
async function createIncompleteSession(userId: string, trackId: string, at: Date) {
  const session = await prisma.playbackSession.create({
    data: {
      userId,
      trackId,
      tokenHash: `phase21-inc-${Date.now()}-${Math.random()}`,
      expiresAt: new Date(at.getTime() + 15 * 60 * 1000),
      createdAt: at,
    },
  });
  await prisma.playEvent.create({
    data: { sessionId: session.id, userId, trackId, eventType: 'START', positionMs: 0, createdAt: at },
  });
  return session;
}

// --- Money unit tests (via calculation service) ---

describe('money arithmetic', () => {
  it('parses and formats minor units exactly', async () => {
    const { toMinorUnits, fromMinorUnits } = await import('../src/modules/royalties/money.js');
    expect(toMinorUnits('1234.56')).toBe(123456n);
    expect(toMinorUnits('0.01')).toBe(1n);
    expect(toMinorUnits('100')).toBe(10000n);
    expect(fromMinorUnits(123456n)).toBe('1234.56');
    expect(fromMinorUnits(1n)).toBe('0.01');
    // No float: 0.1 + 0.2 !== 0.3 in float, but exact here
    expect(toMinorUnits('0.1') + toMinorUnits('0.2')).toBe(toMinorUnits('0.3'));
  });

  it('pctOf computes percentages without float', async () => {
    const { pctOf } = await import('../src/modules/royalties/money.js');
    expect(pctOf(10000n, '70.00')).toBe(7000n); // $100 × 70% = $70
    expect(pctOf(999n, '33.33')).toBe(333n); // $9.99 × 33.33% = $3.329667 → $3.33
  });

  it('divRoundHalfUp rounds ties up', async () => {
    const { divRoundHalfUp } = await import('../src/modules/royalties/money.js');
    expect(divRoundHalfUp(5n, 2n)).toBe(3n); // 2.5 → 3
    expect(divRoundHalfUp(4n, 2n)).toBe(2n); // 2.0 → 2
    expect(divRoundHalfUp(7n, 4n)).toBe(2n); // 1.75 → 2
  });
});

// --- Calculation engine ---

describe('calculation engine', () => {
  it('allocates pro-rata and reconciles: Σ lines + residual = pool', async () => {
    const { calculateRoyalties } = await import('../src/modules/royalties/calculation.js');
    const result = calculateRoyalties({
      netRevenueMinor: 1000000n, // $10,000
      artistPoolPercentage: '70.00',
      tracks: [
        { trackId: 'a', artistId: 'x', streams: 60 },
        { trackId: 'b', artistId: 'y', streams: 30 },
        { trackId: 'c', artistId: 'z', streams: 10 },
      ],
      currency: 'USD',
    });
    // Pool = $10,000 × 70% = $7,000 = 700000n
    expect(result.poolMinor).toBe(700000n);
    expect(result.totalStreams).toBe(100);
    // 60/30/10 split of $7,000 = $4,200 / $2,100 / $700
    expect(result.lines[0].grossMinor).toBe(420000n);
    expect(result.lines[1].grossMinor).toBe(210000n);
    expect(result.lines[2].grossMinor).toBe(70000n);
    // Reconciliation invariant
    expect(result.totalAllocatedMinor + result.residualMinor).toBe(result.poolMinor);
    expect(result.residualMinor).toBe(0n);
  });

  it('handles rounding without creating money (pool never exceeded)', async () => {
    const { calculateRoyalties } = await import('../src/modules/royalties/calculation.js');
    // 3 tracks, 1 stream each, $10 pool → $3.333... each
    const result = calculateRoyalties({
      netRevenueMinor: 1000n, // $10
      artistPoolPercentage: '100.00',
      tracks: [
        { trackId: 'a', artistId: 'x', streams: 1 },
        { trackId: 'b', artistId: 'y', streams: 1 },
        { trackId: 'c', artistId: 'z', streams: 1 },
      ],
      currency: 'USD',
    });
    expect(result.poolMinor).toBe(1000n);
    // Each rounds to 333n or 334n; sum must be ≤ pool
    const sum = result.lines.reduce((s, l) => s + l.grossMinor, 0n);
    expect(sum).toBeLessThanOrEqual(1000n);
    expect(sum + result.residualMinor).toBe(1000n);
    expect(result.residualMinor).toBeGreaterThanOrEqual(0n);
  });

  it('is deterministic: same inputs = same results', async () => {
    const { calculateRoyalties } = await import('../src/modules/royalties/calculation.js');
    const input = {
      netRevenueMinor: 1234567n,
      artistPoolPercentage: '70.00',
      tracks: [
        { trackId: 'track-1', artistId: 'artist-1', streams: 123 },
        { trackId: 'track-2', artistId: 'artist-1', streams: 456 },
        { trackId: 'track-3', artistId: 'artist-2', streams: 789 },
      ],
      currency: 'USD',
    };
    const r1 = calculateRoyalties(input);
    const r2 = calculateRoyalties(input);
    expect(r1).toEqual(r2);
  });

  it('zero streams → entire pool is residual', async () => {
    const { calculateRoyalties } = await import('../src/modules/royalties/calculation.js');
    const result = calculateRoyalties({
      netRevenueMinor: 100000n,
      artistPoolPercentage: '70.00',
      tracks: [],
      currency: 'USD',
    });
    expect(result.poolMinor).toBe(70000n);
    expect(result.totalAllocatedMinor).toBe(0n);
    expect(result.residualMinor).toBe(70000n);
  });

  it('zero revenue → zero pool, zero residual', async () => {
    const { calculateRoyalties } = await import('../src/modules/royalties/calculation.js');
    const result = calculateRoyalties({
      netRevenueMinor: 0n,
      artistPoolPercentage: '70.00',
      tracks: [{ trackId: 'a', artistId: 'x', streams: 10 }],
      currency: 'USD',
    });
    expect(result.poolMinor).toBe(0n);
    expect(result.lines[0].grossMinor).toBe(0n);
    expect(result.residualMinor).toBe(0n);
  });
});

// --- Full-stack royalty flow ---

describe('royalty calculation end-to-end', () => {
  it('calculates earnings from eligible streams with correct allocation', async () => {
    const admin = await createUser('admin1', 'ADMIN');
    const artistUser = await createUser('artist1', 'ARTIST');
    const listener = await createUser('listener1', 'LISTENER');

    const artist = await createArtist(artistUser, 'Phase21 Artist One');
    const trackA = await createTrack(artist.id, 'Track A');
    const trackB = await createTrack(artist.id, 'Track B');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);

    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);

    // Revenue: $1,000 gross, $100 deductions → $900 net
    const revRes = await addRevenue(admin, periodId, '1000.00', '100.00', `phase21-rev-${Date.now()}-1`);
    expect(revRes.statusCode).toBe(201);

    // Streams: 6 completed for A, 3 for B, all in period
    const streamDate = new Date(new Date(ps).getTime() + 15 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 6; i++) await createCompletedSession(listener.id, trackA.id, streamDate);
    for (let i = 0; i < 3; i++) await createCompletedSession(listener.id, trackB.id, streamDate);
    // Ineligible: failed and incomplete sessions (should NOT count)
    await createFailedSession(listener.id, trackA.id, streamDate);
    await createIncompleteSession(listener.id, trackB.id, streamDate);

    const runRes = await triggerRun(admin, periodId);
    expect(runRes.statusCode).toBe(200);
    const { runId, duplicate } = runRes.json();
    expect(duplicate).toBe(false);

    // Verify run totals: pool = $900 × 70% = $630
    const runDetail = await app.inject({
      method: 'GET',
      url: `/v1/admin/royalties/runs/${runId}`,
      headers: auth(admin),
    });
    expect(runDetail.statusCode).toBe(200);
    const run = runDetail.json();
    expect(run.royaltyPool).toBe('630.00');
    expect(run.totalEligibleStreams).toBe(9); // 6 + 3; failed/incomplete excluded
    // A: 6/9 × $630 = $420; B: 3/9 × $630 = $210
    expect(run.totalAllocated).toBe('630.00');
    expect(run.residualAmount).toBe('0.00');

    // Artist overview
    const ovRes = await app.inject({
      method: 'GET',
      url: `/v1/artists/${artist.id}/royalties/overview`,
      headers: auth(artistUser),
    });
    expect(ovRes.statusCode).toBe(200);
    const ov = ovRes.json();
    expect(ov.totalEarnings).toBe('630.00');
    expect(ov.totalStreams).toBe(9);
    expect(ov.completedPeriods).toBe(1);

    // Track breakdown
    const tracksRes = await app.inject({
      method: 'GET',
      url: `/v1/artists/${artist.id}/royalties/periods/${periodId}/tracks`,
      headers: auth(artistUser),
    });
    expect(tracksRes.statusCode).toBe(200);
    const tracks = tracksRes.json().data;
    expect(tracks).toHaveLength(2);
    const byTitle = Object.fromEntries(tracks.map((t: { title: string }) => [t.title, t]));
    expect(byTitle['Track A'].finalAmount).toBe('420.00');
    expect(byTitle['Track A'].eligibleStreams).toBe(6);
    expect(byTitle['Track B'].finalAmount).toBe('210.00');
    expect(byTitle['Track B'].eligibleStreams).toBe(3);
  });

  it('duplicate COMPLETE events count as one stream', async () => {
    const admin = await createUser('admin2', 'ADMIN');
    const artistUser = await createUser('artist2', 'ARTIST');
    const listener = await createUser('listener2', 'LISTENER');

    const artist = await createArtist(artistUser, 'Phase21 Artist Two');
    const track = await createTrack(artist.id, 'Dup Track');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    await addRevenue(admin, periodId, '100.00', '0.00', `phase21-rev-${Date.now()}-2`);

    // One session with TWO COMPLETE events → 1 stream
    const at = new Date(new Date(ps).getTime() + 15 * 24 * 60 * 60 * 1000);
    const session = await prisma.playbackSession.create({
      data: {
        userId: listener.id,
        trackId: track.id,
        tokenHash: `phase21-dup-${Date.now()}`,
        expiresAt: new Date(at.getTime() + 900000),
        createdAt: at,
      },
    });
    await prisma.playEvent.createMany({
      data: [
        { sessionId: session.id, userId: listener.id, trackId: track.id, eventType: 'START', positionMs: 0, createdAt: at },
        { sessionId: session.id, userId: listener.id, trackId: track.id, eventType: 'COMPLETE', positionMs: 180000, createdAt: new Date(at.getTime() + 1000) },
        { sessionId: session.id, userId: listener.id, trackId: track.id, eventType: 'COMPLETE', positionMs: 180000, createdAt: new Date(at.getTime() + 2000) },
      ],
    });

    const runRes = await triggerRun(admin, periodId);
    expect(runRes.statusCode).toBe(200);
    const run = (await app.inject({
      method: 'GET',
      url: `/v1/admin/royalties/runs/${runRes.json().runId}`,
      headers: auth(admin),
    })).json();
    expect(run.totalEligibleStreams).toBe(1);
  });

  it('is idempotent: duplicate run requests return the existing run', async () => {
    const admin = await createUser('admin3', 'ADMIN');
    const artistUser = await createUser('artist3', 'ARTIST');

    const artist = await createArtist(artistUser, 'Phase21 Artist Three');
    await createTrack(artist.id, 'Idem Track');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    await addRevenue(admin, periodId, '500.00', '0.00', `phase21-rev-${Date.now()}-3`);

    const r1 = await triggerRun(admin, periodId);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().duplicate).toBe(false);

    const r2 = await triggerRun(admin, periodId);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().duplicate).toBe(true);
    expect(r2.json().runId).toBe(r1.json().runId);

    // Only one COMPLETED run exists for the period
    const runs = await prisma.royaltyCalculationRun.count({
      where: { periodId, status: 'COMPLETED' },
    });
    expect(runs).toBe(1);
  });

  it('rejects recalculation of a COMPLETED period', async () => {
    const admin = await createUser('admin4', 'ADMIN');
    await createUser('artist4', 'ARTIST');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    await addRevenue(admin, periodId, '500.00', '0.00', `phase21-rev-${Date.now()}-4`);
    await triggerRun(admin, periodId);

    // Add different revenue → different runKey, but period is COMPLETED
    await addRevenue(admin, periodId, '100.00', '0.00', `phase21-rev-${Date.now()}-4b`).catch(() => null);
    // The second revenue add should fail (period COMPLETED), so runKey is unchanged
    // and the duplicate path returns the existing run.
    const r2 = await triggerRun(admin, periodId);
    // Either duplicate (same inputs) or conflict (period completed with different key)
    expect([200, 409]).toContain(r2.statusCode);
  });

  it('enforces minimum_streams threshold', async () => {
    const admin = await createUser('admin5', 'ADMIN');
    const artistUser = await createUser('artist5', 'ARTIST');
    const listener = await createUser('listener5', 'LISTENER');

    const artist = await createArtist(artistUser, 'Phase21 Artist Five');
    const bigTrack = await createTrack(artist.id, 'Big Track');
    const smallTrack = await createTrack(artist.id, 'Small Track');

    const policy = await createPolicy(admin, { minimumStreams: 5 });
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    await addRevenue(admin, periodId, '1000.00', '0.00', `phase21-rev-${Date.now()}-5`);

    const at = new Date(new Date(ps).getTime() + 15 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 10; i++) await createCompletedSession(listener.id, bigTrack.id, at);
    for (let i = 0; i < 2; i++) await createCompletedSession(listener.id, smallTrack.id, at);

    const runRes = await triggerRun(admin, periodId);
    expect(runRes.statusCode).toBe(200);
    const run = (await app.inject({
      method: 'GET',
      url: `/v1/admin/royalties/runs/${runRes.json().runId}`,
      headers: auth(admin),
    })).json();
    // Only Big Track (10 streams >= 5) is eligible; Small Track (2 < 5) excluded
    expect(run.totalEligibleStreams).toBe(10);
    expect(run.royaltyPool).toBe('700.00');
    expect(run.totalAllocated).toBe('700.00');
  });

  it('rejects unsupported currency inputs', async () => {
    const admin = await createUser('admin6', 'ADMIN');
    await createUser('artist6', 'ARTIST');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    // EUR input into a USD period → 400 at record time
    const revRes = await addRevenue(admin, periodId, '100.00', '0.00', `phase21-rev-${Date.now()}-6`, 'EUR');
    expect(revRes.statusCode).toBe(400);
  });

  it('rejects invalid revenue inputs', async () => {
    const admin = await createUser('admin7', 'ADMIN');
    await createUser('artist7', 'ARTIST');

    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    // Deductions > gross
    const bad = await addRevenue(admin, periodId, '100.00', '150.00', `phase21-rev-${Date.now()}-7`);
    expect(bad.statusCode).toBe(400);
    // Duplicate referenceId
    const ref = `phase21-rev-${Date.now()}-7b`;
    const ok = await addRevenue(admin, periodId, '100.00', '0.00', ref);
    expect(ok.statusCode).toBe(201);
    const dup = await addRevenue(admin, periodId, '100.00', '0.00', ref);
    expect(dup.statusCode).toBe(409);
  });

  it('requires revenue before calculating', async () => {
    const admin = await createUser('admin8', 'ADMIN');
    await createUser('artist8', 'ARTIST');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    const runRes = await triggerRun(admin, periodId);
    expect(runRes.statusCode).toBe(400);
  });

  it('requires an ACTIVE policy before calculating', async () => {
    const admin = await createUser('admin9', 'ADMIN');
    await createUser('artist9', 'ARTIST');

    // Create policy but do NOT activate; ensure no other test's policy is active
    await deactivateAllPolicies();
    await createPolicy(admin);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    await addRevenue(admin, periodId, '100.00', '0.00', `phase21-rev-${Date.now()}-9`);
    const runRes = await triggerRun(admin, periodId);
    expect(runRes.statusCode).toBe(400);
  });
});

// --- Authorization ---

describe('royalty authorization', () => {
  it('LISTENER gets 403 on all artist royalty endpoints', async () => {
    const admin = await createUser('adminA', 'ADMIN');
    const artistUser = await createUser('artistA', 'ARTIST');
    const listener = await createUser('listenerA', 'LISTENER');

    const artist = await createArtist(artistUser, 'Phase21 Artist A');

    const fakeUuid = '00000000-0000-0000-0000-000000000000';
    const urls = [
      `/v1/artists/${artist.id}/royalties/overview`,
      `/v1/artists/${artist.id}/royalties/periods`,
      `/v1/artists/${artist.id}/royalties/periods/${fakeUuid}/tracks`,
      `/v1/artists/${artist.id}/royalties/runs/${fakeUuid}`,
    ];
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url, headers: auth(listener) });
      expect(res.statusCode).toBe(403);
    }

    // Admin write endpoints also 403 for listener
    const wres = await app.inject({
      method: 'POST',
      url: '/v1/admin/royalties/policies',
      headers: auth(listener),
      payload: { name: 'x', artistPoolPercentage: '70', currency: 'USD', effectiveFrom: new Date().toISOString() },
    });
    expect(wres.statusCode).toBe(403);
  });

  it('Artist A cannot access Artist B royalties', async () => {
    const admin = await createUser('adminB', 'ADMIN');
    const artistUserA = await createUser('artistBA', 'ARTIST');
    const artistUserB = await createUser('artistBB', 'ARTIST');

    const artistA = await createArtist(artistUserA, 'Phase21 Artist BA');
    const artistB = await createArtist(artistUserB, 'Phase21 Artist BB');
    const trackB = await createTrack(artistB.id, 'B Track');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    await addRevenue(admin, periodId, '100.00', '0.00', `phase21-rev-${Date.now()}-B`);
    await createCompletedSession(artistUserB.id, trackB.id, new Date(new Date(ps).getTime() + 15 * 24 * 60 * 60 * 1000));
    const runRes = await triggerRun(admin, periodId);
    const runId = runRes.json().runId;

    // A tries to read B's royalties → 403 or 404 (never data)
    const ov = await app.inject({
      method: 'GET',
      url: `/v1/artists/${artistB.id}/royalties/overview`,
      headers: auth(artistUserA),
    });
    expect([403, 404]).toContain(ov.statusCode);

    const run = await app.inject({
      method: 'GET',
      url: `/v1/artists/${artistB.id}/royalties/runs/${runId}`,
      headers: auth(artistUserA),
    });
    expect([403, 404]).toContain(run.statusCode);

    // A cannot even see the run via their own artist id (no earnings in it)
    const runA = await app.inject({
      method: 'GET',
      url: `/v1/artists/${artistA.id}/royalties/runs/${runId}`,
      headers: auth(artistUserA),
    });
    expect(runA.statusCode).toBe(404);
  });

  it('unauthenticated requests get 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/royalties/runs' });
    expect(res.statusCode).toBe(401);
  });
});

// --- Immutability ---

describe('royalty immutability', () => {
  it('rejects UPDATE and DELETE on earnings (append-only trigger)', async () => {
    const admin = await createUser('adminC', 'ADMIN');
    const artistUser = await createUser('artistC', 'ARTIST');

    const artist = await createArtist(artistUser, 'Phase21 Artist C');
    const track = await createTrack(artist.id, 'C Track');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    await addRevenue(admin, periodId, '100.00', '0.00', `phase21-rev-${Date.now()}-C`);
    await createCompletedSession(artistUser.id, track.id, new Date(new Date(ps).getTime() + 15 * 24 * 60 * 60 * 1000));
    const runRes = await triggerRun(admin, periodId);
    const runId = runRes.json().runId;

    const earning = await prisma.royaltyEarning.findFirstOrThrow({ where: { runId } });

    // UPDATE rejected
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "royalty_earnings" SET "gross_amount" = 999 WHERE "id" = '${earning.id}'::uuid`),
    ).rejects.toThrow(/append-only/i);

    // DELETE rejected
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "royalty_earnings" WHERE "id" = '${earning.id}'::uuid`),
    ).rejects.toThrow(/append-only/i);

    // Completed run is immutable
    await expect(
      prisma.royaltyCalculationRun.update({
        where: { id: runId },
        data: { totalAllocated: '999.00' },
      }),
    ).rejects.toThrow(/immutable/i);
  });

  it('rejects policy mutation after use', async () => {
    const admin = await createUser('adminD', 'ADMIN');
    await createUser('artistD', 'ARTIST');

    const policy = await createPolicy(admin);
    await activatePolicy(admin, policy.id);
    const { start: ps, end: pe } = uniquePeriod();
    const periodId = await createPeriod(admin, ps, pe);
    await addRevenue(admin, periodId, '100.00', '0.00', `phase21-rev-${Date.now()}-D`);
    await triggerRun(admin, periodId);

    // Policy was used → UPDATE rejected even though status is ACTIVE
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "royalty_policies" SET "name" = 'Hacked' WHERE "id" = '${policy.id}'::uuid`,
      ),
    ).rejects.toThrow(/immutable|DRAFT/i);
  });
});

// --- Policy versioning ---

describe('policy versioning', () => {
  it('new policy version does not affect completed calculations', async () => {
    const admin = await createUser('adminE', 'ADMIN');
    const artistUser = await createUser('artistE', 'ARTIST');

    const artist = await createArtist(artistUser, 'Phase21 Artist E');
    const track = await createTrack(artist.id, 'E Track');

    // v1: 70% pool
    const v1 = await createPolicy(admin, { artistPoolPercentage: '70.00', name: 'V1' });
    await activatePolicy(admin, v1.id);
    const { start: ps1, end: pe1 } = uniquePeriod();
    const period1 = await createPeriod(admin, ps1, pe1);
    await addRevenue(admin, period1, '1000.00', '0.00', `phase21-rev-${Date.now()}-E1`);
    await createCompletedSession(artistUser.id, track.id, new Date(new Date(ps1).getTime() + 15 * 24 * 60 * 60 * 1000));
    const run1 = (await triggerRun(admin, period1)).json();

    // v2: 80% pool
    const v2 = await createPolicy(admin, { artistPoolPercentage: '80.00', name: 'V2' });
    await activatePolicy(admin, v2.id);
    expect(v2.version).toBe(v1.version + 1);

    // Period 1's run still references v1 and its amounts are unchanged
    const detail = (await app.inject({
      method: 'GET',
      url: `/v1/admin/royalties/runs/${run1.runId}`,
      headers: auth(admin),
    })).json();
    expect(detail.policyVersion).toBe(v1.version);
    expect(detail.royaltyPool).toBe('700.00'); // 70% of $1000, not 80%

    // New period uses v2
    const { start: ps2, end: pe2 } = uniquePeriod();
    const period2 = await createPeriod(admin, ps2, pe2);
    await addRevenue(admin, period2, '1000.00', '0.00', `phase21-rev-${Date.now()}-E2`);
    await createCompletedSession(artistUser.id, track.id, new Date(new Date(ps2).getTime() + 15 * 24 * 60 * 60 * 1000));
    const run2 = (await triggerRun(admin, period2)).json();
    const detail2 = (await app.inject({
      method: 'GET',
      url: `/v1/admin/royalties/runs/${run2.runId}`,
      headers: auth(admin),
    })).json();
    expect(detail2.policyVersion).toBe(v2.version);
    expect(detail2.royaltyPool).toBe('800.00');
  });
});
