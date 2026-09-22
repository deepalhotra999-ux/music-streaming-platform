# Phase 22 Report: Royalty Transparency & Artist Financial Reporting

**Date:** 2026-09-21  
**Baseline:** `eade384` (Phase 21)  
**Status:** Complete

## Summary

Built a read-only transparency layer over the Phase 21 royalty engine. Artists can now view server-generated royalty statements with explainable calculations, per-track breakdowns, policy information, and CSV export. Admins get a reconciliation view proving `pool = allocations + residual`. The Phase 21 calculation engine was not modified.

## Acceptance Criteria

### Backend

- [x] Artist statement endpoint with explainable calculation (`GET /v1/artists/:id/royalties/periods/:periodId/statement`)
- [x] Safe policy DTO for artists (human-readable, test-policy labeled)
- [x] Track-level statement breakdown with sorting/pagination
- [x] CSV export endpoint (same records as UI, no recalculation)
- [x] Admin reconciliation endpoint (read-only, invariant verification)
- [x] All endpoints: ownership isolation, LISTENER 403, RFC 7807, pagination
- [x] No mutation APIs; no changes to Phase 21 calculation

### Mobile

- [x] Period detail screen with statement, explanation, tracks, policy
- [x] CSV export via share sheet
- [x] Loading/empty/error/retry/unauthorized states
- [x] Pending/running/failed status handling
- [x] Navigation from royalties list to detail

### Not Built (per brief)

- PDF export (CSV implemented; PDF documented as future work)
- Payout controls, manual earnings editing, historical result modification
- Real-time earnings (batch periods only, per Phase 21)

## Architecture

### New Endpoints

**Artist** (`/v1/artists/:id/royalties/*`, ARTIST owner or ADMIN):

- `GET /periods/:periodId/statement` — full statement with calculation steps
- `GET /periods/:periodId/statement/tracks` — per-track breakdown (sort: earnings|streams)
- `GET /periods/:periodId/statement.csv` — CSV download (completed only)

**Admin** (`/v1/admin/royalties/*`, ADMIN only):

- `GET /runs/:id/reconciliation` — pool, allocations, residual, reconciled flag

### Statement Structure

```typescript
{
  statementReference: "STMT-202608-A1B2C3",  // safe, deterministic
  artistId, artistName,
  periodId, periodStart, periodEnd, currency,
  status: "COMPLETED" | "PENDING" | "RUNNING" | "FAILED",
  finalizedAt,
  policy: { version, name, effectiveFrom, rules..., isTestPolicy },
  eligibleStreams, totalEligibleStreams,
  artistSharePercentage: "66.666666",
  royaltyPool, artistAllocation, adjustmentsTotal,
  residualAmount, finalEarnings,
  calculation: [{ label, value, explanation }]
}
```

### Artist-Visible vs Internal Fields

**Visible to artists:**
- Own streams, earnings, track breakdowns
- Policy version, rules (human-readable), test-policy label
- Platform aggregates needed for verification: total streams, royalty pool, residual
- Safe statement reference (not internal run key)

**Never exposed to artists:**
- Internal run keys (SHA-256)
- Revenue hashes, raw provider payloads
- Other artists' earnings or identities
- Database IDs beyond the artist's own resources

### Reconciliation

Admin endpoint returns:
- `royaltyPool`, `totalAllocated`, `residualAmount` (from records)
- `reconciled: boolean` — true iff `pool == allocated + residual`
- `artistCount`, `trackCount`, `totalEligibleStreams`

If `reconciled` is false, the UI must mark the calculation as inconsistent. The API never auto-fixes.

### Export Format

CSV with sections: header, summary, calculation steps, tracks. Deterministic column order. Same values as JSON statement (no recalculation).

## Verification

### Backend Tests

- **32/32 royalty tests pass** (23 Phase 21 + 9 Phase 22)
- Statement retrieval (completed, pending)
- Track breakdown with share percentages
- CSV export contents and authorization
- Cross-artist isolation (403)
- LISTENER 403 on all endpoints
- ADMIN access to statements
- Reconciliation invariant (pool = allocated + residual)
- No internal key leakage

### Mobile Tests

- **17/17 royalty tests pass** (7 Phase 21 + 10 Phase 22)
- Statement rendering, calculation steps, track breakdown
- Policy display with test label
- Pending/failed states
- Error/retry, unauthorized states
- CSV export via share
- Navigation from list to detail

### TypeScript

- Backend: clean
- Mobile: clean
- Admin: (no Phase 22 changes)

## Files Created

### Backend

- `services/api/src/modules/royalties/statementService.ts` — statement generation, CSV export
- `services/api/tests/royalties.test.ts` — 9 new tests (appended)

### Mobile

- `apps/mobile/src/screens/RoyaltyPeriodDetailScreen.tsx` — detail UI
- `apps/mobile/src/screens/__tests__/RoyaltyPeriodDetailScreen.test.tsx` — 10 tests
- `apps/mobile/src/app/(artist)/royalties/[periodId].tsx` — route

### Docs

- `docs/PHASE-22-REPORT.md` — this report

## Files Modified

### Backend

- `services/api/src/modules/royalties/adminService.ts` — added `getReconciliation()`
- `services/api/src/modules/royalties/adminRoutes.ts` — reconciliation route
- `services/api/src/modules/royalties/artistRoutes.ts` — statement routes
- `services/api/src/modules/royalties/schemas.ts` — new schemas

### Mobile

- `apps/mobile/src/api/royalties.ts` — statement API wrappers
- `apps/mobile/src/api/client.ts` — added `getText()` for CSV
- `apps/mobile/src/screens/ArtistRoyaltiesScreen.tsx` — navigate to detail
- `apps/mobile/src/screens/__tests__/ArtistRoyaltiesScreen.test.tsx` — updated navigation test
- `apps/mobile/package.json` — added expo-file-system, expo-sharing

## Known Limitations

1. **No PDF export** — CSV only; PDF is future work
2. **Batch periods only** — no real-time earnings (per Phase 21)
3. **Test policy values** — clearly labeled; production values must be configured
4. **No adjustment write API** — corrections use new runs (per Phase 21/ADR-016)
5. **Failed periods** — manual intervention required (per Phase 21)

## Database Changes

None. Phase 22 is read-only; no migrations.

## Stopping Point

Phase 22 is complete and ready for commit. Phase 23 has not been started.
