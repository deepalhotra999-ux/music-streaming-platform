-- CreateEnum
CREATE TYPE "StoreStatus" AS ENUM ('ACTIVE', 'PAUSED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('APPAREL', 'ACCESSORY', 'MUSIC', 'ART', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'SOLD_OUT', 'ARCHIVED', 'REMOVED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CommercePaymentStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "CommerceRefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ModerationTargetType" ADD VALUE 'PRODUCT';
ALTER TYPE "ModerationTargetType" ADD VALUE 'ARTIST_STORE';

-- DropForeignKey
ALTER TABLE "offline_download_authorizations" DROP CONSTRAINT "offline_download_authorizations_track_id_fkey";

-- DropForeignKey
ALTER TABLE "offline_download_authorizations" DROP CONSTRAINT "offline_download_authorizations_user_id_fkey";

-- DropForeignKey
ALTER TABLE "play_events" DROP CONSTRAINT "play_events_offline_authorization_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_adjustments" DROP CONSTRAINT "royalty_adjustments_artist_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_adjustments" DROP CONSTRAINT "royalty_adjustments_earning_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_adjustments" DROP CONSTRAINT "royalty_adjustments_run_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_calculation_runs" DROP CONSTRAINT "royalty_calculation_runs_period_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_calculation_runs" DROP CONSTRAINT "royalty_calculation_runs_policy_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_earnings" DROP CONSTRAINT "royalty_earnings_artist_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_earnings" DROP CONSTRAINT "royalty_earnings_run_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_earnings" DROP CONSTRAINT "royalty_earnings_track_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_eligible_streams" DROP CONSTRAINT "royalty_eligible_streams_artist_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_eligible_streams" DROP CONSTRAINT "royalty_eligible_streams_run_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_eligible_streams" DROP CONSTRAINT "royalty_eligible_streams_track_id_fkey";

-- DropForeignKey
ALTER TABLE "royalty_revenue_inputs" DROP CONSTRAINT "royalty_revenue_inputs_period_id_fkey";

-- AlterTable
ALTER TABLE "offline_download_authorizations" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "plans" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "royalty_adjustments" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "royalty_calculation_runs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "royalty_earnings" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "royalty_eligible_streams" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "royalty_periods" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "royalty_policies" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "royalty_revenue_inputs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "subscriptions" ALTER COLUMN "provider" SET DEFAULT 'DEV';

-- CreateTable
CREATE TABLE "artist_stores" (
    "id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "StoreStatus" NOT NULL DEFAULT 'ACTIVE',
    "image_url" TEXT,
    "banner_url" TEXT,
    "contact_email" TEXT,
    "contact_url" TEXT,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "shipping_flat_cents" INTEGER NOT NULL DEFAULT 0,
    "order_sequence" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "artist_stores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "ProductType" NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "sku" TEXT,
    "image_url" TEXT,
    "track_id" UUID,
    "album_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "image_url" TEXT NOT NULL,
    "alt_text" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "quantity_available" INTEGER NOT NULL DEFAULT 0,
    "quantity_reserved" INTEGER NOT NULL DEFAULT 0,
    "quantity_sold" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_orders" (
    "id" UUID NOT NULL,
    "order_number" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "store_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" CHAR(3) NOT NULL,
    "subtotal_cents" INTEGER NOT NULL,
    "shipping_cents" INTEGER NOT NULL,
    "tax_cents" INTEGER NOT NULL DEFAULT 0,
    "total_cents" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "shipping_name" TEXT,
    "shipping_line1" TEXT,
    "shipping_line2" TEXT,
    "shipping_city" TEXT,
    "shipping_region" TEXT,
    "shipping_postal" TEXT,
    "shipping_country" TEXT,
    "shipping_phone" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID,
    "product_title" TEXT NOT NULL,
    "variant_name" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,

    CONSTRAINT "commerce_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_payment_id" TEXT NOT NULL,
    "status" "CommercePaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_payment_events" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commerce_payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commerce_refunds" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "reason" TEXT,
    "status" "CommerceRefundStatus" NOT NULL DEFAULT 'PENDING',
    "provider_refund_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "commerce_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "artist_stores_artist_id_key" ON "artist_stores"("artist_id");

-- CreateIndex
CREATE INDEX "products_store_id_status_idx" ON "products"("store_id", "status");

-- CreateIndex
CREATE INDEX "products_artist_id_status_idx" ON "products"("artist_id", "status");

-- CreateIndex
CREATE INDEX "product_variants_product_id_sort_order_idx" ON "product_variants"("product_id", "sort_order");

-- CreateIndex
CREATE INDEX "product_images_product_id_sort_order_idx" ON "product_images"("product_id", "sort_order");

-- CreateIndex
CREATE INDEX "inventory_items_product_id_idx" ON "inventory_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "carts_user_id_key" ON "carts"("user_id");

-- CreateIndex
CREATE INDEX "cart_items_cart_id_idx" ON "cart_items"("cart_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_order_number_key" ON "commerce_orders"("order_number");

-- CreateIndex
CREATE INDEX "commerce_orders_user_id_created_at_idx" ON "commerce_orders"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "commerce_orders_store_id_created_at_idx" ON "commerce_orders"("store_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "commerce_orders_status_idx" ON "commerce_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_orders_user_idem_key" ON "commerce_orders"("user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "commerce_order_items_order_id_idx" ON "commerce_order_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payments_order_id_key" ON "commerce_payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payments_idempotency_key_key" ON "commerce_payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "commerce_payments_provider_provider_payment_id_idx" ON "commerce_payments"("provider", "provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_payment_events_provider_event_id_key" ON "commerce_payment_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "commerce_payment_events_payment_id_idx" ON "commerce_payment_events"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "commerce_refunds_idempotency_key_key" ON "commerce_refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "commerce_refunds_order_id_idx" ON "commerce_refunds"("order_id");

-- AddForeignKey
ALTER TABLE "play_events" ADD CONSTRAINT "play_events_offline_authorization_id_fkey" FOREIGN KEY ("offline_authorization_id") REFERENCES "offline_download_authorizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_download_authorizations" ADD CONSTRAINT "offline_download_authorizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_download_authorizations" ADD CONSTRAINT "offline_download_authorizations_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_revenue_inputs" ADD CONSTRAINT "royalty_revenue_inputs_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "royalty_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_calculation_runs" ADD CONSTRAINT "royalty_calculation_runs_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "royalty_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_calculation_runs" ADD CONSTRAINT "royalty_calculation_runs_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "royalty_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_earnings" ADD CONSTRAINT "royalty_earnings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "royalty_calculation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_earnings" ADD CONSTRAINT "royalty_earnings_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_earnings" ADD CONSTRAINT "royalty_earnings_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_adjustments" ADD CONSTRAINT "royalty_adjustments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "royalty_calculation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_adjustments" ADD CONSTRAINT "royalty_adjustments_earning_id_fkey" FOREIGN KEY ("earning_id") REFERENCES "royalty_earnings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_adjustments" ADD CONSTRAINT "royalty_adjustments_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_eligible_streams" ADD CONSTRAINT "royalty_eligible_streams_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "royalty_calculation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_eligible_streams" ADD CONSTRAINT "royalty_eligible_streams_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "royalty_eligible_streams" ADD CONSTRAINT "royalty_eligible_streams_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artist_stores" ADD CONSTRAINT "artist_stores_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "artist_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_orders" ADD CONSTRAINT "commerce_orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "artist_stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_items" ADD CONSTRAINT "commerce_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_items" ADD CONSTRAINT "commerce_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_order_items" ADD CONSTRAINT "commerce_order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_payments" ADD CONSTRAINT "commerce_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_payment_events" ADD CONSTRAINT "commerce_payment_events_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "commerce_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "commerce_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commerce_refunds" ADD CONSTRAINT "commerce_refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "commerce_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "offline_download_authorizations_expires_idx" RENAME TO "offline_download_authorizations_expires_at_idx";

-- RenameIndex
ALTER INDEX "offline_download_authorizations_user_expires_idx" RENAME TO "offline_download_authorizations_user_id_expires_at_idx";

-- RenameIndex
ALTER INDEX "offline_download_authorizations_user_track_key" RENAME TO "offline_download_authorizations_user_id_track_id_key";

-- RenameIndex
ALTER INDEX "play_events_offline_authorization_idx" RENAME TO "play_events_offline_authorization_id_idx";

-- RenameIndex
ALTER INDEX "play_events_offline_session_idx" RENAME TO "play_events_user_id_offline_session_key_idx";

-- RenameIndex
ALTER INDEX "playback_sessions_user_offline_key" RENAME TO "playback_sessions_user_id_offline_session_key_key";

-- Phase 30 — partial unique indexes enforcing one inventory row per
-- purchasable unit (product-level when variant_id IS NULL, variant-level
-- otherwise) and one cart line per purchasable per cart. Plain Prisma
-- unique constraints cannot express these because NULLs are distinct.
CREATE UNIQUE INDEX "inventory_items_product_key" ON "inventory_items"("product_id") WHERE "variant_id" IS NULL;
CREATE UNIQUE INDEX "inventory_items_variant_key" ON "inventory_items"("variant_id") WHERE "variant_id" IS NOT NULL;
CREATE UNIQUE INDEX "cart_items_product_key" ON "cart_items"("cart_id", "product_id") WHERE "variant_id" IS NULL;
CREATE UNIQUE INDEX "cart_items_variant_key" ON "cart_items"("cart_id", "variant_id") WHERE "variant_id" IS NOT NULL;

-- Phase 30 — append-only enforcement for commerce_payment_events.
-- Provider webhook history must never be mutated or deleted, mirroring the
-- Phase 18 subscription_events and Phase 16 admin_audit_logs pattern.
CREATE OR REPLACE FUNCTION reject_commerce_payment_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'commerce_payment_events is append-only: % is not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_payment_events_no_update ON "commerce_payment_events";
CREATE TRIGGER commerce_payment_events_no_update
  BEFORE UPDATE ON "commerce_payment_events"
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_payment_event_mutation();

DROP TRIGGER IF EXISTS commerce_payment_events_no_delete ON "commerce_payment_events";
CREATE TRIGGER commerce_payment_events_no_delete
  BEFORE DELETE ON "commerce_payment_events"
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_payment_event_mutation();
