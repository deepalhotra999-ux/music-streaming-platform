# ADR-016: Royalty Engine & Auditable Artist Earnings

**Status:** Accepted  
**Date:** 2026-09-22  
**Phase:** 21

## Context

The platform needs to calculate artist royalty earnings from streaming activity in a way that is:

- **Deterministic** — same inputs + policy always produce the same outputs
- **Reproducible** — any run can be re-verified from its inputs
- **Auditable** — every allocation traces to its run, period, policy, artist, track, financial inputs, and exact listening sessions
- **Idempotent** — retrying a calculation never duplicates earnings
- **Immutable** — completed history cannot be mutated

Royalties must consume verified server-side financial inputs (Phase 18/19 subscription revenue), never client purchase callbacks, and never grant entitlement. Royalties are separate from entitlements and subscriptions.

## Decision

### Stream semantics (from ADR-011)

Reuse Phase 15 playback event semantics exactly:

- **Playback session** is the unit of play
- **≥1 `COMPLETE` event** in a session = one eligible stream
- **Duplicate `COMPLETE` events** for the same session count once
- **Failed or incomplete sessions** do not count

A per-policy `minimumStreamThreshold` excludes artists below the threshold from allocation (their streams are not eligible).

### Money: integer minor units, never float

All monetary values use integer minor units (cents) in application code and PostgreSQL `NUMERIC(19,2)` in storage. JavaScript floating-point arithmetic is never used for money. Percentage calculations use integer math with explicit remainder handling.

### Allocation algorithm

For a completed period with verified revenue inputs:

1. **Pool** = `netRevenue × artistPoolPercentage / 100` (integer division, remainder → residual)
2. **Per-artist allocation** = `pool × artistStreams / totalStreams` (integer division per artist)
3. **Residual** = `pool - Σ(allocations)` — the unallocated remainder from integer division
4. **Invariant:** `Σ(allocations) + residual = pool` (proven by test)

The residual is recorded on the run, not silently dropped. This is honest accounting for the dust that integer division creates.

### Idempotency via deterministic run keys

Each calculation run has a deterministic `runKey` = `SHA-256(periodId | policyId | policyVersion | revenueHash | streamSnapshotHash)`. Retrying with identical inputs returns the existing completed run without duplicating earnings. Retrying with different inputs on a completed period is a 409 conflict.

### Append-only audit tables

All royalty tables are append-only with database triggers rejecting UPDATE/DELETE:

- `royalty_policies` — versioned policy configurations
- `royalty_periods` — accounting periods with status lifecycle
- `royalty_revenue_inputs` — verified server-side revenue (never client callbacks)
- `royalty_calculation_runs` — each calculation attempt with inputs hash, pool, residual
- `royalty_earnings` — per-track allocations (immutable once written)
- `royalty_eligible_streams` — exact session IDs that contributed to each run
- `royalty_adjustments` — manual corrections (append-only; readers sum dynamically)

### Eligible-stream snapshot

Each run records the exact `playback_session_id` values that were counted. This provides:

- **Traceability** — any earning can be traced to its specific listening sessions
- **Auditability** — an auditor can verify the stream count independently
- **Idempotency proof** — the unique constraint on `(run_id, playback_session_id)` prevents double-counting

### Policy versioning

Policies are immutable once used. A policy can only transition `DRAFT → ACTIVE → RETIRED`. Financial fields cannot change after the policy has been used in a calculation. Only one ACTIVE policy exists at a time.

### Period lifecycle

`OPEN → CALCULATING → COMPLETED` (or `→ FAILED` on error). Revenue inputs can only be added to OPEN periods. Calculation only runs on OPEN periods with an ACTIVE policy.

### Artist isolation

Artist endpoints return only the requesting artist's data:

- No platform pool, residual, or total stream counts
- No internal run keys or error details
- No other artists' earnings

Admin endpoints expose full platform data for audit.

### Adjustment model

`royalty_earnings` rows are immutable allocation snapshots. The `adjustmentsTotal` and `finalAmount` fields represent the initial calculation. Manual adjustments are recorded as separate append-only rows in `royalty_adjustments`. Readers computing current balances must sum adjustments dynamically: `current = finalAmount + Σ(adjustments)`.

No adjustment write API is provided in Phase 21; the table exists for future use. Corrections requiring reallocation use new calculation runs, not mutations.

## Consequences

### Positive

- Fully auditable: every cent traces to its source
- Deterministic and reproducible calculations
- Idempotent retries prevent duplicate payments
- Immutable history prevents tampering
- Clear separation from entitlements and payouts

### Negative

- Integer division creates residuals (documented, not hidden)
- No real-time earnings; batch period calculations only
- Storage overhead from session-level snapshots

### Limitations

- No payouts, Stripe Connect, PayPal, tax forms, or withdrawals (explicitly out of scope)
- Policy percentages are versioned placeholders, not final business terms
- Unsupported currencies fail safely (no invented exchange rates)
- Minimum threshold is per-policy configurable

## References

- Phase 15: ADR-011 (analytics event aggregation, stream semantics)
- Phase 18/19: Subscription revenue models (financial inputs)
- Phase 20: Subscription UX (entitlement separation)
