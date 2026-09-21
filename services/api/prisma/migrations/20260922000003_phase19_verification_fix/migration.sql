-- Phase 19 fix — Prisma names enum types after the Prisma enum
-- ("VerificationStatus", PascalCase quoted); the previous migration created
-- snake_case verification_status. Rename in-transaction-safely.

CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED');

ALTER TABLE subscriptions
  ALTER COLUMN verification_status DROP DEFAULT;

ALTER TABLE subscriptions
  ALTER COLUMN verification_status TYPE "VerificationStatus"
  USING verification_status::text::"VerificationStatus";

ALTER TABLE subscriptions
  ALTER COLUMN verification_status SET DEFAULT 'UNVERIFIED'::"VerificationStatus";

DROP TYPE verification_status;
