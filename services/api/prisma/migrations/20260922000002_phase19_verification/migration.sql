-- Phase 19 — store verification tracking + grace-period event type.

-- Verification status on subscriptions: VERIFIED once a store adapter has
-- verified this subscription through signature/API checks; UNVERIFIED for
-- rows established through the DEV adapter.
CREATE TYPE verification_status AS ENUM ('UNVERIFIED', 'VERIFIED');

ALTER TABLE subscriptions
  ADD COLUMN verification_status verification_status NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN last_verified_at TIMESTAMPTZ(6) NULL;

-- Add SUBSCRIPTION_GRACE_PERIOD to the event-type enum.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block (and Prisma
-- wraps migrations in one), so the enum is swapped in-transaction-safely.
-- NOTE: Prisma names this enum "SubscriptionEventType" (PascalCase, quoted).
CREATE TYPE "SubscriptionEventType_new" AS ENUM (
  'SUBSCRIPTION_STARTED',
  'TRIAL_STARTED',
  'TRIAL_CONVERTED',
  'RENEWAL_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_RECOVERED',
  'PLAN_CHANGED',
  'SUBSCRIPTION_CANCELED',
  'SUBSCRIPTION_EXPIRED',
  'SUBSCRIPTION_REVOKED',
  'SUBSCRIPTION_GRACE_PERIOD'
);

ALTER TABLE subscription_events
  ALTER COLUMN event_type TYPE "SubscriptionEventType_new"
  USING event_type::text::"SubscriptionEventType_new";

DROP TYPE "SubscriptionEventType";
ALTER TYPE "SubscriptionEventType_new" RENAME TO "SubscriptionEventType";
