# Phase 21 Report: Royalty Engine & Auditable Artist Earnings

**Date:** 2026-09-22  
**Baseline:** `e4b9b46` (Phase 20)  
**Status:** Complete

## Summary

Implemented a deterministic, auditable royalty calculation engine that converts eligible streams and verified subscription revenue into per-track artist earnings. All calculations use integer minor-unit arithmetic (never floating point), produce append-only immutable records, and are fully traceable to their run, period, policy, financial inputs, and exact playback sessions.

## Acceptance Criteria

### Backend

- [x] Royalty policy CRUD with versioning (DRAFT → ACTIVE → RETIRED, immutable after use)
- [x] Accounting periods with lifecycle (OPEN → CALCULATING → COMPLETED/FAILED)
- [x] Verified revenue inputs (server-side only, never client callbacks)
- [x] Deterministic calculation with integer arithmetic
- [x] Rounding invariant: `Σ(allocations) + residual = pool` (proven by test)
- [x] Idempotent retries via deterministic run keys (SHA-256 of inputs)
- [x] Eligible-stream session snapshots for audit traceability
- [x] Append-only tables with DB triggers rejecting UPDATE/DELETE
- [x] Artist endpoints with ownership isolation (LISTENER 403, no platform data leakage)
- [x] Admin endpoints for runs, periods, policies, pools, residuals, artist/track totals
- [x] RFC 7807 error responses, pagination on list endpoints

### Mobile

- [x] Artist Royalties screen with real backend data
- [x] Loading, empty, error, retry, and unauthorized (403) states
- [x] Historical period browsing with expandable track breakdowns
- [x] Exact decimal money formatting (no Number conversion)
- [x] Artist switcher for multi-artist accounts

### Not Built (per brief)

- Payouts, Stripe Connect, PayPal, tax forms, withdrawals, transfers, automatic payments
- Adjustment write API (table exists for future use; model documented in ADR-016)

## Architecture

### Database Tables (migration `20260922000004_phase21_royalties`)

| Table                      | Purpose                  | Immutability                             |
| -------------------------- | ------------------------ | ---------------------------------------- |
| `royalty_policies`         | Versioned policy configs | Trigger: no UPDATE/DELETE after use      |
| `royalty_periods`          | Accounting periods       | Status lifecycle enforced                |
| `royalty_revenue_inputs`   | Verified revenue         | Append-only                              |
| `royalty_calculation_runs` | Calculation attempts     | Append-only, deterministic runKey        |
| `royalty_earnings`         | Per-track allocations    | Append-only                              |
| `royalty_eligible_streams` | Session ID snapshots     | Append-only, unique (run_id, session_id) |
| `royalty_adjustments`      | Manual corrections       | Append-only (no write API yet)           |

### Calculation Flow

1. Admin creates period (OPEN) and records verified revenue inputs
2. Admin triggers calculation on OPEN period
3. System validates: ACTIVE policy exists, period is OPEN, revenue inputs present
4. System computes revenue hash and stream snapshot hash
5. System checks for existing run with same deterministic runKey:
   - If completed with same inputs → return existing (idempotent)
   - If completed with different inputs → 409 conflict
6. Period transitions OPEN → CALCULATING
7. Eligible streams computed from `play_events` (Phase 15 semantics):
   - One COMPLETE per session = one stream
   - Duplicate COMPLETEs deduplicated
   - Failed/incomplete sessions excluded
   - Below-threshold artists excluded
8. Pool = netRevenue × artistPoolPercentage (integer math)
9. Per-artist allocation = pool × artistStreams / totalStreams (integer division)
10. Residual = pool − Σ(allocations)
11. Earnings, snapshots, and run written atomically
12. Period transitions CALCULATING → COMPLETED

### API Endpoints

**Admin** (`/v1/admin/royalties/*`, ADMIN only):

- `POST /policies` — create policy (DRAFT)
- `GET /policies` — list policies (paginated)
- `POST /policies/:id/activate` — activate policy
- `POST /periods` — create period (OPEN)
- `GET /periods` — list periods with summaries (paginated)
- `GET /periods/:id` — period detail with revenue and runs
- `POST /revenue` — record revenue input
- `POST /runs` — trigger calculation
- `GET /runs` — list runs (paginated)
- `GET /runs/:id` — run detail with pool/residual
- `GET /runs/:id/artists` — artist-level totals (paginated)
- `GET /runs/:id/tracks` — track-level totals (paginated)

**Artist** (`/v1/artists/:id/royalties/*`, ARTIST owner only):

- `GET /overview` — lifetime totals and latest period
- `GET /periods` — per-period earnings (paginated)
- `GET /periods/:periodId` — period detail for artist
- `GET /periods/:periodId/tracks` — track breakdown (paginated)
- `GET /runs/:runId` — artist-safe run detail (no platform data)

## Verification

### Backend Tests

- **23/23 royalty tests pass** (`tests/royalties.test.ts`)
- Rounding invariant proven: `Σ(allocations) + residual = pool`
- Determinism proven: same inputs → same runKey → same outputs
- Idempotency proven: retry with same inputs returns existing run
- Immutability proven: triggers reject UPDATE/DELETE on all tables
- Artist isolation proven: LISTENER 403, cross-artist 403, no platform data in artist DTOs
- Snapshot integrity: exact session IDs recorded, duplicates prevented by unique constraint

### Mobile Tests

- **7/7 ArtistRoyaltiesScreen tests pass**
- Overview rendering with exact decimal amounts
- Period expansion with track breakdown
- Empty state (no earnings yet)
- Error state with retry
- Unauthorized (403) state
- Artist bootstrap (single fetch, no duplicates)
- `formatMoney` preserves precision for large amounts

### TypeScript

- Backend: `npx tsc --noEmit` clean
- Mobile: `npx tsc --noEmit` clean
- Admin: (no Phase 21 changes)

### Lint & Format

- ESLint: clean (backend and mobile)
- Prettier: clean

### Manual Verification

- Calculation verified end-to-end with test data
- Residual correctly captures integer division remainder
- Failed runs transition period to FAILED without corrupting data

## Files Created

### Backend

- `services/api/src/modules/royalties/types.ts` — shared types
- `services/api/src/modules/royalties/calculationService.ts` — deterministic engine
- `services/api/src/modules/royalties/adminService.ts` — admin operations
- `services/api/src/modules/royalties/artistService.ts` — artist-safe queries
- `services/api/src/modules/royalties/adminRoutes.ts` — admin HTTP routes
- `services/api/src/modules/royalties/artistRoutes.ts` — artist HTTP routes
- `services/api/src/modules/royalties/schemas.ts` — validation schemas
- `services/api/tests/royalties.test.ts` — 23 integration tests
- `services/api/prisma/migrations/20260922000004_phase21_royalties/migration.sql`

### Mobile

- `apps/mobile/src/api/royalties.ts` — API wrappers + exact decimal `formatMoney`
- `apps/mobile/src/screens/ArtistRoyaltiesScreen.tsx` — royalties UI
- `apps/mobile/src/screens/__tests__/ArtistRoyaltiesScreen.test.tsx` — 7 tests
- `apps/mobile/src/app/(artist)/royalties.tsx` — route

### Docs

- `docs/adr/016-royalty-engine.md` — architecture decision record
- `docs/PHASE-21-REPORT.md` — this report

## Files Modified

### Backend

- `services/api/prisma/schema.prisma` — 7 new models
- `services/api/src/http/app.ts` — route registration

### Mobile

- `apps/mobile/src/api/index.ts` — export royalties
- `apps/mobile/src/app/(artist)/_layout.tsx` — add royalties route
- `apps/mobile/src/screens/ArtistDashboardScreen.tsx` — link to royalties

## Known Limitations

1. **No payout integration** — earnings are recorded, not paid out (explicitly out of scope)
2. **Batch only** — calculations run per-period, not real-time
3. **Placeholder percentages** — policy values are configurable test values, not final business terms
4. **Single currency per period** — multi-currency periods fail safely (no invented FX rates)
5. **No adjustment write API** — table exists; corrections use new runs (documented in ADR-016)
6. **Failed runs** — period moves to FAILED; manual intervention required to retry (no auto-retry)

## Database Notes

Migration was amended after initial application during development. Both `musicdb` and `musicdb_test` were manually patched (trigger replacement, snapshot table creation, ownership fixes). For production deployment, recreate from the final migration file to ensure checksum consistency.

## Stopping Point

Phase 21 is complete and ready for commit. Phase 22 has not been started.
