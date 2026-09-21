-- Phase 18 — subscriptions & entitlements.
--
-- 1. SubscriptionStatus gains TRIALING and REVOKED (ADD VALUE is safe
--    inside a transaction on PG 12+ as long as the new values are not used
--    in the same transaction — they are not).
-- 2. New enums: SubscriptionProvider, PlanType, SubscriptionEventType.
-- 3. New `plans` table, seeded with the three launch plans. Store product
--    IDs stay NULL until real Apple/Google integration configures them;
--    dev_product_id values are deterministic placeholders for the DEV
--    adapter only.
-- 4. `subscriptions`: free-form `store` becomes typed `provider` enum
--    (legacy dev rows with NULL store backfill to DEV), `store_subscription_id`
--    is renamed to `external_subscription_id`, `plan_id` becomes a real FK
--    to `plans` (legacy Phase 2 seed value 'premium-monthly' maps to
--    'premium_individual' — the seed's shape-only subscription was always
--    an individual-style plan), plus `canceled_at` and the idempotency
--    unique key (provider, external_subscription_id).
-- 5. New append-only `subscription_events` table: one row per applied
--    provider event, unique on (provider, provider_event_id) so duplicate
--    deliveries can never fork history.

-- Extend the status enum first (new values unused in this transaction).
ALTER TYPE "SubscriptionStatus" ADD VALUE 'TRIALING';
ALTER TYPE "SubscriptionStatus" ADD VALUE 'REVOKED';

-- New enums.
CREATE TYPE "SubscriptionProvider" AS ENUM ('APPLE', 'GOOGLE', 'DEV');
CREATE TYPE "PlanType" AS ENUM ('INDIVIDUAL', 'FAMILY', 'STUDENT');
CREATE TYPE "SubscriptionEventType" AS ENUM (
  'SUBSCRIPTION_STARTED',
  'TRIAL_STARTED',
  'TRIAL_CONVERTED',
  'RENEWAL_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_RECOVERED',
  'PLAN_CHANGED',
  'SUBSCRIPTION_CANCELED',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_REVOKED'
);

-- Plans table.
CREATE TABLE "plans" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "plan_type" "PlanType" NOT NULL,
  "apple_product_id" TEXT,
  "google_product_id" TEXT,
  "dev_product_id" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- Seed the three launch plans. Idempotent: safe to re-run.
INSERT INTO "plans" ("id", "name", "plan_type", "dev_product_id", "active", "created_at", "updated_at")
VALUES
  ('premium_individual', 'Premium Individual', 'INDIVIDUAL', 'dev.waveform.premium.individual', true, NOW(), NOW()),
  ('premium_family', 'Premium Family', 'FAMILY', 'dev.waveform.premium.family', true, NOW(), NOW()),
  ('premium_student', 'Premium Student', 'STUDENT', 'dev.waveform.premium.student', true, NOW(), NOW())
ON CONFLICT ("id") DO NOTHING;

-- subscriptions: typed provider. Existing rows default to DEV; rows that
-- carried a recognizable store value keep it.
ALTER TABLE "subscriptions" ADD COLUMN "provider" "SubscriptionProvider" NOT NULL DEFAULT 'DEV';
UPDATE "subscriptions"
SET "provider" = UPPER("store")::"SubscriptionProvider"
WHERE "store" IS NOT NULL AND UPPER("store") IN ('APPLE', 'GOOGLE', 'DEV');
ALTER TABLE "subscriptions" ALTER COLUMN "provider" DROP DEFAULT;

-- subscriptions: rename the external id column, add canceled_at.
ALTER TABLE "subscriptions" RENAME COLUMN "store_subscription_id" TO "external_subscription_id";
ALTER TABLE "subscriptions" ADD COLUMN "canceled_at" TIMESTAMPTZ(6);

-- Legacy Phase 2 seed value ('premium-monthly' was shape-only) maps onto
-- the individual plan so the plan FK can be enforced without losing rows.
UPDATE "subscriptions" SET "plan_id" = 'premium_individual' WHERE "plan_id" = 'premium-monthly';
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Drop the free-form store column and its old index; add the idempotency
-- unique key and the latest-subscription lookup index.
ALTER TABLE "subscriptions" DROP COLUMN "store";
DROP INDEX IF EXISTS "subscriptions_store_store_subscription_id_idx";
ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_provider_external_subscription_id_key"
  UNIQUE ("provider", "external_subscription_id");
CREATE INDEX "subscriptions_user_id_created_at_idx"
  ON "subscriptions"("user_id", "created_at" DESC);

-- Append-only subscription event history.
CREATE TABLE "subscription_events" (
  "id" UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "provider" "SubscriptionProvider" NOT NULL,
  "provider_event_id" TEXT NOT NULL,
  "event_type" "SubscriptionEventType" NOT NULL,
  "status_from" "SubscriptionStatus",
  "status_to" "SubscriptionStatus",
  "payload" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "subscription_events"
  ADD CONSTRAINT "subscription_events_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_events"
  ADD CONSTRAINT "subscription_events_provider_provider_event_id_key"
  UNIQUE ("provider", "provider_event_id");
CREATE INDEX "subscription_events_subscription_id_created_at_idx"
  ON "subscription_events"("subscription_id", "created_at");
