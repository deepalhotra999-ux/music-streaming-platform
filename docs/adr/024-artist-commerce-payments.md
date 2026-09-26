# ADR-024: Artist Commerce / Store with Payment Processing

Date: 2026-09-26
Status: Accepted

## Context

Phase 30 introduces artist commerce: verified artists can operate a store selling physical
and digital merchandise, fans can purchase via cart/checkout with real payment processing,
and admins can moderate stores/products. This is distinct from the existing royalty system
(subscriptions, streams, payouts) and must not mix with royalty accounting.

Key constraints from the Phase 30 brief:
- No general marketplace, no arbitrary third-party sellers
- Commerce money must never touch royalty accounting
- Inventory must be transactionally oversell-safe
- Money in integer minor units with explicit currency, no floating point
- Checkout/payments/webhooks/refunds idempotent
- Works without live processor credentials in development
- Commerce requires connectivity; no offline/car/room commerce

## Decision

### Data model (Prisma)

New models in `services/api/prisma/schema.prisma`:
- `ArtistStore` — one per artist, owned by a verified artist
- `Product`, `ProductVariant`, `ProductImage` — catalog with variants (absolute prices)
- `InventoryItem` — per-product/variant stock: `quantityAvailable`, `quantityReserved`, `quantitySold`
- `Cart`, `CartItem` — one cart per user, items reference variants
- `CommerceOrder`, `CommerceOrderItem` — orders with historical snapshots
- `CommercePayment`, `CommercePaymentEvent`, `CommerceRefund` — payment lifecycle

Key invariants:
- One store per artist (`@@unique([artistId])`)
- One cart per user (`@@unique([userId])`)
- Partial unique indexes on nullable `variantId` for inventory/cart rows
- Append-only `CommercePaymentEvent` enforced by DB triggers rejecting UPDATE/DELETE
- `CommerceOrderItem` stores title/variant/price snapshots at checkout time

### Inventory semantics

- `quantityAvailable` = physical on-hand total
- `quantityReserved` = subset earmarked for unpaid orders
- Purchasable stock = `quantityAvailable - quantityReserved`
- Reservation atomically increments `quantityReserved` guarded by sufficient free stock
- Payment success: decrement `quantityReserved` and `quantityAvailable`, increment `quantitySold`
- Payment failure/cancellation: decrement only `quantityReserved`
- Refund: decrement sold, increment available

### Payment provider abstraction

`PaymentProvider` interface in `src/modules/commerce/payments/provider.ts`:
- `createIntent`, `confirmIntent`, `cancelIntent`, `refund`, `verifyWebhook`
- `MockProvider` for development — no credentials required
- Production provider selected via `COMMERCE_PAYMENT_PROVIDER` env var
- Never trust client callbacks as payment proof; server confirms with provider
- Webhooks verified via HMAC signature

### Money handling

- Integer minor units everywhere (cents)
- Explicit currency on every monetary field
- No floating point arithmetic on money
- No currency conversion
- Per-currency aggregates in admin stats (never sum across currencies)

### Idempotency

- Checkout requires client-supplied idempotency key (per-user unique)
- Payment operations idempotent by provider intent ID
- Webhook events deduplicated by provider event ID
- Refunds idempotent by idempotency key

### Rate limiting

Commerce endpoints use a dedicated rate-limit bucket (`commerce`) separate from
auth/catalog to prevent checkout abuse without affecting playback.

### Royalty isolation

Commerce revenue is recorded in separate tables (`CommerceOrder`, `CommercePayment`)
and never appears in:
- Playback events or stream counts
- Royalty runs, pools, or balances
- Subscription revenue
- Analytics

Verified by `royalty-isolation` test comparing royalty table counts before/after
a paid commerce order.

### Addresses and privacy

Shipping addresses:
- Never enter public APIs, logs, search, recommendations, analytics, community, or AI
- Stored encrypted at rest (field-level)
- Only visible to buyer, store owner (for fulfillment), and admin
- Never included in audit log metadata

### Moderation

- Admin can suspend/reinstate stores
- Admin can remove/restore products
- All moderation actions audited via existing `admin_audit_logs`
- Store creation requires verified artist ownership (server-derived)

## Consequences

- New migration `20260926013646_phase30_commerce` (applied, do not edit)
- New module `src/modules/commerce/` with service/cart/paymentState/orders/routes/schemas
- Admin UI: Commerce page with store/product/order tabs and per-currency stats
- Mobile: `(commerce)` customer stack, `(artist)` store/products/orders management
- Mock provider enables full E2E testing without credentials
- Production requires implementing a real `PaymentProvider` (Stripe/PayPal/etc.)
