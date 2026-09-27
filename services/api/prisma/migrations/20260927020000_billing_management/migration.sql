-- Billing management — advanced subscription system.
--
-- 1. Plan catalog pricing: price, currency, billing interval, trial length,
--    feature list, and sort order. Plans become fully manageable from the
--    admin console instead of seed-only records.
-- 2. Promo codes: percent or fixed-amount discounts with redemption limits,
--    plan scoping, and validity windows. Redemptions are append-only.
--
-- Billing kill switch + grace period live in platform_settings (no schema
-- change needed): billing.subscriptions_enabled, billing.grace_period_days.

-- Billing interval for plan pricing.
CREATE TYPE "BillingInterval" AS ENUM ('WEEK', 'MONTH', 'YEAR');

ALTER TABLE "plans"
  ADD COLUMN "price_cents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN "billing_interval" "BillingInterval" NOT NULL DEFAULT 'MONTH',
  ADD COLUMN "interval_count" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "trial_days" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "features" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- Sensible defaults for the seeded plans (editable from the admin console).
UPDATE "plans" SET
  "price_cents" = 999,
  "currency" = 'USD',
  "billing_interval" = 'MONTH',
  "interval_count" = 1,
  "trial_days" = 7,
  "features" = '["Ad-free listening","Offline downloads","High-quality audio","Unlimited skips"]',
  "sort_order" = 1
WHERE "id" = 'premium_individual';

UPDATE "plans" SET
  "price_cents" = 1499,
  "currency" = 'USD',
  "billing_interval" = 'MONTH',
  "interval_count" = 1,
  "trial_days" = 7,
  "features" = '["Everything in Individual","Up to 6 accounts","Family mix playlists","Explicit content filters"]',
  "sort_order" = 2
WHERE "id" = 'premium_family';

UPDATE "plans" SET
  "price_cents" = 499,
  "currency" = 'USD',
  "billing_interval" = 'MONTH',
  "interval_count" = 1,
  "trial_days" = 7,
  "features" = '["Everything in Individual","Student discount","Ad-free listening","Offline downloads"]',
  "sort_order" = 3
WHERE "id" = 'premium_student';

-- Promo codes. Exactly one of percent_off / amount_off_cents must be set.
CREATE TABLE "promo_codes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" CITEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "percent_off" INTEGER,
  "amount_off_cents" INTEGER,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "max_redemptions" INTEGER,
  "redeemed_count" INTEGER NOT NULL DEFAULT 0,
  "starts_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "active" BOOLEAN NOT NULL DEFAULT true,
  -- JSON array of plan ids this code applies to; empty = all plans.
  "applicable_plans" JSONB NOT NULL DEFAULT '[]',
  "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promo_codes_code_unique" UNIQUE ("code"),
  CONSTRAINT "promo_codes_discount_check" CHECK (
    ("percent_off" IS NOT NULL AND "amount_off_cents" IS NULL)
    OR ("percent_off" IS NULL AND "amount_off_cents" IS NOT NULL)
  ),
  CONSTRAINT "promo_codes_percent_check" CHECK ("percent_off" IS NULL OR ("percent_off" >= 1 AND "percent_off" <= 100)),
  CONSTRAINT "promo_codes_amount_check" CHECK ("amount_off_cents" IS NULL OR "amount_off_cents" > 0),
  CONSTRAINT "promo_codes_max_redemptions_check" CHECK ("max_redemptions" IS NULL OR "max_redemptions" > 0),
  CONSTRAINT "promo_codes_redeemed_check" CHECK ("redeemed_count" >= 0)
);

CREATE INDEX "promo_codes_active_idx" ON "promo_codes" ("active");

-- Append-only promo redemption ledger. One redemption per user per code.
CREATE TABLE "promo_redemptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "promo_code_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "subscription_id" UUID,
  "redeemed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "promo_redemptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promo_redemptions_promo_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "promo_redemptions_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "promo_redemptions_subscription_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "promo_redemptions_one_per_user" UNIQUE ("promo_code_id", "user_id")
);

CREATE INDEX "promo_redemptions_user_idx" ON "promo_redemptions" ("user_id");
CREATE INDEX "promo_redemptions_promo_idx" ON "promo_redemptions" ("promo_code_id");
