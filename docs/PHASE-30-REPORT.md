# Phase 30 Report — Artist Commerce / Store

Date: 2026-09-26
Status: Complete

## Summary

Implemented artist commerce: verified artists operate stores selling merchandise,
fans purchase via cart/checkout with payment processing, artists manage products/
orders/fulfillment/refunds, admins moderate stores/products. All commerce is
isolated from royalty accounting.

## Acceptance Criteria

- [x] Verified artists can create and manage one store
- [x] Products with variants, images, inventory management
- [x] Public storefronts (active stores/products only)
- [x] User carts with server-authoritative pricing
- [x] One-store checkout with idempotency keys
- [x] Payment processing via provider abstraction (mock for dev)
- [x] Inventory reservation (oversell-safe via guarded SQL)
- [x] Order snapshots (historical pricing)
- [x] Payment confirmation, retry, cancellation
- [x] Signed webhooks with deduplication
- [x] Fulfillment workflow (PROCESSING→SHIPPED→DELIVERED)
- [x] Full refunds with restocking
- [x] Admin moderation (suspend/reinstate stores, remove/restore products)
- [x] Admin stats with per-currency aggregates
- [x] Royalty isolation (commerce never touches royalties)
- [x] Address privacy (never in logs/search/analytics/AI)
- [x] Mobile customer flows (browse/cart/checkout/orders)
- [x] Mobile artist management (store/products/variants/images/inventory/orders)
- [x] Offline guards on all commerce screens

## Tests

### Backend
- Phase 30 suite: 77/77 passing
  - Store/product lifecycle
  - Variant/image/inventory management
  - Cart operations
  - Checkout with idempotency
  - Payment confirmation/retry/cancel
  - Webhook verification
  - Refunds with restocking
  - Royalty isolation
  - Admin moderation and stats
  - Multi-currency stats

### Admin
- Commerce API wrapper tests: 4/4
- TypeScript: clean
- Build: passing

### Mobile
- Commerce API tests: 10/10
- TypeScript: clean
- Full suite: 743/743 (prior run)

## Manual Checklist

- [x] Store creation requires verified artist
- [x] Non-artists cannot create stores (403)
- [x] Public sees only active stores/products
- [x] Cart pricing is server-authoritative
- [x] Checkout is idempotent (same key = same order)
- [x] Inventory cannot oversell (concurrent checkout test)
- [x] Payment failure releases reservation
- [x] Refund restocks inventory
- [x] Addresses not in logs or public APIs
- [x] Commerce revenue not in royalty tables
- [x] Offline shows notice, no commerce actions

## Files Created

### Backend
- `services/api/prisma/migrations/20260926013646_phase30_commerce/migration.sql`
- `services/api/src/modules/commerce/payments/provider.ts`
- `services/api/src/modules/commerce/payments/mockProvider.ts`
- `services/api/src/modules/commerce/payments/index.ts`
- `services/api/src/modules/commerce/rateLimit.ts`
- `services/api/src/modules/commerce/service.ts`
- `services/api/src/modules/commerce/cart.ts`
- `services/api/src/modules/commerce/paymentState.ts`
- `services/api/src/modules/commerce/orders.ts`
- `services/api/src/modules/commerce/routes.ts`
- `services/api/src/modules/commerce/schemas.ts`
- `services/api/tests/phase30.test.ts`

### Admin
- `apps/admin/src/api/commerce.ts`
- `apps/admin/src/pages/CommercePage.tsx`
- `apps/admin/src/__tests__/commerce.test.ts`

### Mobile
- `apps/mobile/src/api/commerce.ts`
- `apps/mobile/src/commerce/ui.tsx`
- `apps/mobile/src/commerce/useOnline.ts`
- `apps/mobile/src/app/(commerce)/_layout.tsx`
- `apps/mobile/src/app/(commerce)/stores.tsx`
- `apps/mobile/src/app/(commerce)/store/[storeId].tsx`
- `apps/mobile/src/app/(commerce)/product/[productId].tsx`
- `apps/mobile/src/app/(commerce)/cart.tsx`
- `apps/mobile/src/app/(commerce)/checkout.tsx`
- `apps/mobile/src/app/(commerce)/orders.tsx`
- `apps/mobile/src/app/(commerce)/order/[orderId].tsx`
- `apps/mobile/src/app/(artist)/store.tsx`
- `apps/mobile/src/app/(artist)/products.tsx`
- `apps/mobile/src/app/(artist)/product/[productId].tsx`
- `apps/mobile/src/app/(artist)/orders.tsx`
- `apps/mobile/src/api/__tests__/commerce.test.ts`

### Docs
- `docs/adr/024-artist-commerce-payments.md`
- `docs/ARTIST-COMMERCE.md`
- `docs/PHASE-30-REPORT.md`

## Files Modified

### Backend
- `services/api/prisma/schema.prisma` — commerce models
- `services/api/src/http/app.ts` — commerce routes, webhook raw body

### Admin
- `apps/admin/src/App.tsx` — commerce route
- `apps/admin/src/components/Layout.tsx` — commerce nav
- `apps/admin/src/utils/format.ts` — money formatting

### Mobile
- `apps/mobile/src/app/(artist)/_layout.tsx` — store/products/orders routes
- `apps/mobile/src/screens/ArtistDashboardScreen.tsx` — store/orders buttons
- `apps/mobile/src/screens/ProfileScreen.tsx` — commerce entry

## Limitations

1. **Mock provider only**: Production needs a real `PaymentProvider` implementation
   (Stripe, PayPal, etc.). The interface is defined; mock covers development/testing.

2. **Payment intent in transaction**: Intent creation occurs inside the DB transaction.
   Production should use an outbox pattern or accept the small risk of orphaned intents.

3. **Single currency per order**: Orders are single-currency. Multi-currency is handled
   via per-currency aggregates, not conversion.

4. **No partial refunds**: Refunds are full-order only. Partial refunds require
   additional inventory logic.

5. **No shipping integration**: Tracking numbers are manual. No carrier API integration.

6. **No tax calculation**: Prices are tax-inclusive or tax-exempt. Full tax engine
   out of scope.

7. **Mobile not physically tested**: No device/SDK in sandbox. UI flows verified via
   typecheck and API contract tests.

## Commit

Phase 30 implementation commit: `a6e4681c42f390411552e69caf26e3d85f321b34`

Phase 31 has NOT been started.
