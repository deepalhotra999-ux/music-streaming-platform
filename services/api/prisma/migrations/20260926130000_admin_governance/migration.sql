-- Admin V2 governance: SUPER_ADMIN + named operational roles with permission
-- bundles, custom bans, reversible audit actions, chargebacks, login/device
-- history, feature flags, platform settings, and impersonation support.

-- Admin V2 privilege model: SUPER_ADMIN at the top, plus named operational roles.
-- Existing ADMIN keeps all existing access (backward compatible). New super
-- powers (role management, audit reversal, impersonation, emergency controls,
-- platform config, feature flags) are SUPER_ADMIN-only and do NOT
-- auto-propagate to existing ADMIN accounts.
ALTER TYPE "UserRole" ADD VALUE 'SUPER_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'PLATFORM_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'MODERATOR';
ALTER TYPE "UserRole" ADD VALUE 'SUPPORT_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'FINANCE_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'CONTENT_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'ARTIST_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'ANALYTICS_ADMIN';

-- Reportable users for the moderation queue.
ALTER TYPE "ModerationTargetType" ADD VALUE 'USER';

-- Users: custom bans (reason + optional expiry) and sub-admin permission grants.
ALTER TABLE "users" ADD COLUMN "banned_at" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "ban_reason" TEXT;
ALTER TABLE "users" ADD COLUMN "banned_until" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "admin_permissions" TEXT[] NOT NULL DEFAULT '{}';

-- Audit log: reversibility support. Rows stay append-only (the trigger still
-- rejects UPDATE/DELETE); a reversal is a NEW row pointing at the original
-- via reversal_of. before_state/after_state hold the facts needed to invert
-- an action (role names, emails, permission sets, statuses — never secrets).
ALTER TABLE "admin_audit_logs" ADD COLUMN "reversible" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "admin_audit_logs" ADD COLUMN "before_state" JSONB;
ALTER TABLE "admin_audit_logs" ADD COLUMN "after_state" JSONB;
ALTER TABLE "admin_audit_logs" ADD COLUMN "reversal_of" UUID REFERENCES "admin_audit_logs"("id");

-- Chargebacks: recording one auto-cancels the subscription (service layer).
CREATE TABLE "chargebacks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "subscription_id" UUID NOT NULL REFERENCES "subscriptions"("id") ON DELETE CASCADE,
  "provider_ref" TEXT,
  "amount_cents" INTEGER,
  "currency" CHAR(3),
  "reason" TEXT,
  "recorded_by" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "chargebacks_subscription_id_idx" ON "chargebacks"("subscription_id");

-- Login history: every authentication attempt, success or failure.
CREATE TABLE "login_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "email" TEXT NOT NULL,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "success" BOOLEAN NOT NULL,
  "failure_reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);
CREATE INDEX "login_events_user_id_created_at_idx" ON "login_events"("user_id", "created_at" DESC);

-- Active devices: refresh tokens carry the IP/user-agent they were minted from.
ALTER TABLE "refresh_tokens" ADD COLUMN "ip_address" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "user_agent" TEXT;

-- Feature flags: controlled rollouts. Changed only via SUPER_ADMIN-gated
-- endpoints; every change is audited. No code/config execution.
CREATE TABLE "feature_flags" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "rollout_percent" INTEGER NOT NULL DEFAULT 100,
  "description" TEXT,
  "updated_by" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- Platform settings: strongly-typed operational settings. Values are JSONB
-- but every key has a server-side validator; the API rejects unknown keys
-- and out-of-range values. Emergency controls live under "emergency.*".
CREATE TABLE "platform_settings" (
  "key" TEXT NOT NULL PRIMARY KEY,
  "value" JSONB NOT NULL,
  "updated_by" UUID REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- Admin V2 — artist account-level suspension. Hidden from public listings,
-- reversible via restore; distinct from soft-delete and track TAKEDOWN.
ALTER TABLE "artists" ADD COLUMN "suspended_at" TIMESTAMPTZ(6);
ALTER TABLE "artists" ADD COLUMN "suspended_reason" TEXT;
CREATE INDEX "artists_suspended_at_idx" ON "artists"("suspended_at");
