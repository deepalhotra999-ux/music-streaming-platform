-- Phase 21 — Royalty Engine & Auditable Artist Earnings.
--
-- Financial accounting foundation: royalty calculation periods, versioned
-- immutable policies, revenue inputs, calculation runs, per-track earnings
-- lines, and adjustments. All financial records are append-only (triggers
-- reject UPDATE/DELETE, following the Phase 16/18 pattern).
--
-- Money uses NUMERIC(19,4): 4 decimal places for intermediate precision;
-- the calculation service works in integer minor units and rounds per
-- policy. No JavaScript floating-point arithmetic touches money.

-- Royalty policy versions. Immutable once used by a calculation run.
CREATE TABLE "royalty_policies" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "version" INTEGER NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  -- Percentage of net revenue allocated to the artist pool (e.g., 70.00
  -- = 70%). PLACEHOLDER: production value must be configured before launch.
  "artist_pool_percentage" NUMERIC(7,4) NOT NULL CHECK ("artist_pool_percentage" >= 0 AND "artist_pool_percentage" <= 100),
  -- Minimum eligible streams for a track to earn (NULL = no minimum).
  -- PLACEHOLDER: production value must be configured before launch.
  "minimum_streams" INTEGER CHECK ("minimum_streams" IS NULL OR "minimum_streams" >= 0),
  -- ISO 4217 currency code for calculations under this policy.
  "currency" TEXT NOT NULL DEFAULT 'USD',
  -- Rounding mode for per-line allocation: 'HALF_UP' (standard).
  "rounding_mode" TEXT NOT NULL DEFAULT 'HALF_UP' CHECK ("rounding_mode" IN ('HALF_UP')),
  -- Additional policy parameters (eligibility thresholds, etc.) as JSON.
  "config" JSONB NOT NULL DEFAULT '{}',
  "effective_from" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_by" UUID
);

-- Royalty calculation periods (e.g., calendar months). One completed
-- calculation run per period.
CREATE TABLE "royalty_periods" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "period_start" TIMESTAMPTZ(6) NOT NULL,
  "period_end" TIMESTAMPTZ(6) NOT NULL CHECK ("period_end" > "period_start"),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" TEXT NOT NULL DEFAULT 'OPEN'
    CHECK ("status" IN ('OPEN', 'CALCULATING', 'COMPLETED', 'FAILED')),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_by" UUID,
  UNIQUE ("period_start", "period_end")
);

-- Revenue inputs for a period (e.g., subscription revenue). Append-only:
-- corrections are new rows, never updates.
CREATE TABLE "royalty_revenue_inputs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "period_id" UUID NOT NULL REFERENCES "royalty_periods"("id") ON DELETE RESTRICT,
  -- Revenue source: 'SUBSCRIPTION', 'AD', etc. Provider-neutral.
  "source" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  -- Gross revenue before deductions, in major units (e.g., dollars).
  "gross_amount" NUMERIC(19,4) NOT NULL CHECK ("gross_amount" >= 0),
  -- Deductions (store commissions, taxes, etc.) in major units.
  "deductions" NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK ("deductions" >= 0),
  -- Net revenue = gross - deductions. Computed by the service; stored for audit.
  "net_amount" NUMERIC(19,4) NOT NULL CHECK ("net_amount" >= 0),
  -- Idempotency key: duplicate submissions with the same reference are rejected.
  "reference_id" TEXT NOT NULL UNIQUE,
  -- Optional exchange-rate reference (e.g., "1 USD = 1 USD"). Never invented.
  "fx_reference" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_by" UUID
);
CREATE INDEX "royalty_revenue_inputs_period_id_idx" ON "royalty_revenue_inputs"("period_id");

-- Calculation runs. One COMPLETED run per period; recalculation creates a
-- new run (with a new run_key), never mutates the old one.
CREATE TABLE "royalty_calculation_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "period_id" UUID NOT NULL REFERENCES "royalty_periods"("id") ON DELETE RESTRICT,
  "policy_id" UUID NOT NULL REFERENCES "royalty_policies"("id") ON DELETE RESTRICT,
  "status" TEXT NOT NULL DEFAULT 'PENDING'
    CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  -- Deterministic idempotency key: e.g., "period:<id>:policy:v3:revenue:<hash>".
  "run_key" TEXT NOT NULL UNIQUE,
  -- Snapshot of revenue inputs at calculation time (for audit/reproducibility).
  "revenue_snapshot" JSONB NOT NULL DEFAULT '{}',
  "total_eligible_streams" BIGINT NOT NULL DEFAULT 0 CHECK ("total_eligible_streams" >= 0),
  -- Royalty pool in major units (net revenue * artist pool %).
  "royalty_pool" NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK ("royalty_pool" >= 0),
  -- Sum of all allocated line amounts in major units.
  "total_allocated" NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK ("total_allocated" >= 0),
  -- Explicit residual: pool - total_allocated. Never silently lost.
  "residual_amount" NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK ("residual_amount" >= 0),
  "currency" TEXT NOT NULL,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_by" UUID
);
CREATE INDEX "royalty_calculation_runs_period_id_idx" ON "royalty_calculation_runs"("period_id");
-- Only one COMPLETED run per period: partial unique index.
CREATE UNIQUE INDEX "royalty_runs_one_completed_per_period"
  ON "royalty_calculation_runs"("period_id")
  WHERE "status" = 'COMPLETED';

-- Per-track earnings lines. Append-only: one row per (run, artist, track).
-- Artist totals are derived by summing lines; no separate artist-total rows
-- (avoids double-counting and keeps the audit trail to a single grain).
CREATE TABLE "royalty_earnings" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL REFERENCES "royalty_calculation_runs"("id") ON DELETE RESTRICT,
  "artist_id" UUID NOT NULL REFERENCES "artists"("id") ON DELETE RESTRICT,
  "track_id" UUID NOT NULL REFERENCES "tracks"("id") ON DELETE RESTRICT,
  -- Eligible streams for this track in the period (Phase 15 semantics:
  -- sessions with >= 1 COMPLETE, counted once per session).
  "eligible_streams" BIGINT NOT NULL CHECK ("eligible_streams" >= 0),
  -- Track's share of total eligible streams, as a percentage (e.g., 12.3456).
  "allocation_percentage" NUMERIC(9,6) NOT NULL CHECK ("allocation_percentage" >= 0 AND "allocation_percentage" <= 100),
  -- Gross allocated amount in major units (before adjustments).
  "gross_amount" NUMERIC(19,4) NOT NULL CHECK ("gross_amount" >= 0),
  -- Sum of adjustments applied to this line (can be negative).
  "adjustments_total" NUMERIC(19,4) NOT NULL DEFAULT 0,
  -- Final amount = gross_amount + adjustments_total.
  "final_amount" NUMERIC(19,4) NOT NULL CHECK ("final_amount" >= 0),
  "currency" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  UNIQUE ("run_id", "artist_id", "track_id")
);
CREATE INDEX "royalty_earnings_run_id_idx" ON "royalty_earnings"("run_id");
CREATE INDEX "royalty_earnings_artist_id_idx" ON "royalty_earnings"("artist_id");
CREATE INDEX "royalty_earnings_track_id_idx" ON "royalty_earnings"("track_id");

-- Adjustments and reversals. Append-only: each row references the earning
-- line it adjusts (or the run for run-level adjustments). Never mutate
-- the earnings row; the final amount is gross + sum(adjustments).
CREATE TABLE "royalty_adjustments" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL REFERENCES "royalty_calculation_runs"("id") ON DELETE RESTRICT,
  "earning_id" UUID REFERENCES "royalty_earnings"("id") ON DELETE RESTRICT,
  "artist_id" UUID NOT NULL REFERENCES "artists"("id") ON DELETE RESTRICT,
  -- Adjustment amount in major units (negative for reversals/deductions).
  "amount" NUMERIC(19,4) NOT NULL,
  "currency" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  -- Idempotency key for the adjustment.
  "reference_id" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "created_by" UUID
);
CREATE INDEX "royalty_adjustments_run_id_idx" ON "royalty_adjustments"("run_id");
CREATE INDEX "royalty_adjustments_earning_id_idx" ON "royalty_adjustments"("earning_id");

-- Eligible listening activity snapshot: the exact playback sessions counted
-- for a run. Append-only; provides traceability from earnings back to the
-- specific listening activity (session IDs) that produced them.
CREATE TABLE "royalty_eligible_streams" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL REFERENCES "royalty_calculation_runs"("id") ON DELETE RESTRICT,
  -- The playback session counted as one eligible stream (Phase 15 semantics:
  -- session with >= 1 COMPLETE event). Stored as TEXT (not FK) so the snapshot
  -- survives even if source playback data is later purged.
  "playback_session_id" UUID NOT NULL,
  "track_id" UUID NOT NULL REFERENCES "tracks"("id") ON DELETE RESTRICT,
  "artist_id" UUID NOT NULL REFERENCES "artists"("id") ON DELETE RESTRICT,
  "session_created_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "royalty_eligible_streams_run_session_key" UNIQUE ("run_id", "playback_session_id")
);
CREATE INDEX "royalty_eligible_streams_run_id_idx" ON "royalty_eligible_streams"("run_id");
CREATE INDEX "royalty_eligible_streams_track_id_idx" ON "royalty_eligible_streams"("track_id");
CREATE INDEX "royalty_eligible_streams_artist_id_idx" ON "royalty_eligible_streams"("artist_id");

-- --- Append-only enforcement (Phase 16/18 pattern) -------------------------

CREATE OR REPLACE FUNCTION reject_royalty_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Revenue inputs: append-only.
DROP TRIGGER IF EXISTS royalty_revenue_inputs_no_update ON "royalty_revenue_inputs";
CREATE TRIGGER royalty_revenue_inputs_no_update
  BEFORE UPDATE ON "royalty_revenue_inputs"
  FOR EACH ROW EXECUTE FUNCTION reject_royalty_mutation();
DROP TRIGGER IF EXISTS royalty_revenue_inputs_no_delete ON "royalty_revenue_inputs";
CREATE TRIGGER royalty_revenue_inputs_no_delete
  BEFORE DELETE ON "royalty_revenue_inputs"
  FOR EACH ROW EXECUTE FUNCTION reject_royalty_mutation();

-- Earnings lines: append-only.
DROP TRIGGER IF EXISTS royalty_earnings_no_update ON "royalty_earnings";
CREATE TRIGGER royalty_earnings_no_update
  BEFORE UPDATE ON "royalty_earnings"
  FOR EACH ROW EXECUTE FUNCTION reject_royalty_mutation();
DROP TRIGGER IF EXISTS royalty_earnings_no_delete ON "royalty_earnings";
CREATE TRIGGER royalty_earnings_no_delete
  BEFORE DELETE ON "royalty_earnings"
  FOR EACH ROW EXECUTE FUNCTION reject_royalty_mutation();

-- Adjustments: append-only.
DROP TRIGGER IF EXISTS royalty_adjustments_no_update ON "royalty_adjustments";
CREATE TRIGGER royalty_adjustments_no_update
  BEFORE UPDATE ON "royalty_adjustments"
  FOR EACH ROW EXECUTE FUNCTION reject_royalty_mutation();
DROP TRIGGER IF EXISTS royalty_adjustments_no_delete ON "royalty_adjustments";
CREATE TRIGGER royalty_adjustments_no_delete
  BEFORE DELETE ON "royalty_adjustments"
  FOR EACH ROW EXECUTE FUNCTION reject_royalty_mutation();

-- Eligible streams snapshot: append-only.
DROP TRIGGER IF EXISTS royalty_eligible_streams_no_update ON "royalty_eligible_streams";
CREATE TRIGGER royalty_eligible_streams_no_update
  BEFORE UPDATE ON "royalty_eligible_streams"
  FOR EACH ROW EXECUTE FUNCTION reject_royalty_mutation();
DROP TRIGGER IF EXISTS royalty_eligible_streams_no_delete ON "royalty_eligible_streams";
CREATE TRIGGER royalty_eligible_streams_no_delete
  BEFORE DELETE ON "royalty_eligible_streams"
  FOR EACH ROW EXECUTE FUNCTION reject_royalty_mutation();

-- Policies: immutable once ACTIVE/RETIRED or referenced by a run.
-- DRAFT policies may be edited; anything else is frozen.
CREATE OR REPLACE FUNCTION reject_policy_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'royalty_policies is immutable: DELETE is not allowed';
  END IF;
  -- Allow status-only ACTIVE -> RETIRED transition even for used policies
  -- (lifecycle state, not a financial parameter). All financial fields must be unchanged.
  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED'
     AND OLD.version = NEW.version
     AND OLD.name = NEW.name
     AND OLD.artist_pool_percentage = NEW.artist_pool_percentage
     AND COALESCE(OLD.minimum_streams, -1) = COALESCE(NEW.minimum_streams, -1)
     AND OLD.currency = NEW.currency
     AND OLD.rounding_mode = NEW.rounding_mode
     AND OLD.effective_from = NEW.effective_from THEN
    RETURN NEW;
  END IF;
  -- Policies used by a calculation run are otherwise completely immutable.
  IF EXISTS (SELECT 1 FROM royalty_calculation_runs WHERE policy_id = OLD.id) THEN
    RAISE EXCEPTION 'royalty_policies: policy version % has been used by a calculation run and is immutable', OLD.version;
  END IF;
  -- Unused policies: allow DRAFT -> ACTIVE, but no other modifications once out of DRAFT.
  IF OLD.status = 'DRAFT' AND NEW.status IN ('DRAFT', 'ACTIVE') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'royalty_policies: only DRAFT policies may be modified (version % is %)', OLD.version, OLD.status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS royalty_policies_immutable ON "royalty_policies";
CREATE TRIGGER royalty_policies_immutable
  BEFORE UPDATE OR DELETE ON "royalty_policies"
  FOR EACH ROW EXECUTE FUNCTION reject_policy_mutation();

-- Calculation runs: status transitions only (PENDING -> RUNNING ->
-- COMPLETED/FAILED). Completed runs are frozen; financial fields on a
-- COMPLETED run may never change.
CREATE OR REPLACE FUNCTION check_royalty_run_transition()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'royalty_calculation_runs is immutable: DELETE is not allowed';
  END IF;
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'royalty_calculation_runs: COMPLETED runs are immutable';
  END IF;
  -- Valid transitions: PENDING -> RUNNING -> COMPLETED | FAILED;
  -- FAILED -> RUNNING (retry); PENDING -> FAILED.
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('RUNNING', 'FAILED')) OR
    (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'FAILED')) OR
    (OLD.status = 'FAILED' AND NEW.status IN ('RUNNING', 'PENDING')) OR
    (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'royalty_calculation_runs: invalid status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS royalty_runs_transition ON "royalty_calculation_runs";
CREATE TRIGGER royalty_runs_transition
  BEFORE UPDATE OR DELETE ON "royalty_calculation_runs"
  FOR EACH ROW EXECUTE FUNCTION check_royalty_run_transition();

-- Periods: status transitions only; COMPLETED periods are frozen.
CREATE OR REPLACE FUNCTION check_royalty_period_transition()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'royalty_periods: DELETE is not allowed';
  END IF;
  IF OLD.status = 'COMPLETED' AND NEW.status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'royalty_periods: COMPLETED periods are immutable';
  END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status IN ('CALCULATING', 'FAILED')) OR
    (OLD.status = 'CALCULATING' AND NEW.status IN ('COMPLETED', 'FAILED')) OR
    (OLD.status = 'FAILED' AND NEW.status IN ('CALCULATING', 'OPEN')) OR
    (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'royalty_periods: invalid status transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS royalty_periods_transition ON "royalty_periods";
CREATE TRIGGER royalty_periods_transition
  BEFORE UPDATE OR DELETE ON "royalty_periods"
  FOR EACH ROW EXECUTE FUNCTION check_royalty_period_transition();
