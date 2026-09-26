# Artist Commerce Guide

Phase 30 — Artist stores, products, carts, checkout, orders, and refunds.

## Overview

Verified artists can operate a store selling merchandise. Fans browse stores,
add items to a cart, checkout with payment, and track orders. Artists manage
products, variants, images, inventory, orders, fulfillment, and refunds.

This is NOT a general marketplace. Only verified artists can create stores.
Commerce revenue is completely separate from music royalties.

## For Artists

### Creating a store

1. You must have a verified artist profile
2. Go to Artist Dashboard → My store
3. Create your store with a name and description
4. Your store goes live after admin approval

### Managing products

From Artist Dashboard → Products:
- Tap a product to open its detail page
- Edit title, description, price
- Add variants (e.g. sizes, colors) with absolute prices
- Add/reorder/remove product images
- Set inventory levels per variant

### Managing orders

From Artist Dashboard → Store orders:
- View all orders for your store
- Tap an order to expand details
- Advance fulfillment: PROCESSING → SHIPPED → DELIVERED
- Issue full refunds with a reason

### Inventory

- Set stock quantities per product/variant
- Available = on-hand, Reserved = earmarked for unpaid orders
- Purchasable = Available − Reserved
- Stock automatically adjusts on payment success/failure/refund

## For Fans

### Shopping

1. Browse stores from the Commerce tab
2. View products, select variants
3. Add to cart (one cart, items grouped by store)
4. Checkout with shipping address
5. Pay via the payment provider
6. Track orders in My Orders

### Important notes

- Commerce requires an internet connection
- No offline purchases
- Shipping addresses are private and never shared
- Refunds are issued by the artist

## For Admins

### Moderation

From Admin → Commerce:
- **Stores tab**: Suspend/reinstate stores
- **Products tab**: Remove/restore products
- **Orders tab**: View all orders

### Stats

Per-currency aggregates:
- Store/product/order counts
- Gross revenue by currency
- Refunds by currency

All moderation actions are audited.

## Technical Details

### Payment flow

1. `POST /v1/commerce/checkout` — creates order, reserves inventory, creates payment intent
2. Payment provider processes payment
3. `POST /v1/commerce/orders/:id/confirm-payment` — server confirms with provider
4. On success: inventory sold, order PAID
5. On failure: inventory released, order PENDING_PAYMENT (retry available)

### Webhooks

`POST /v1/commerce/webhooks/:provider` — verified via HMAC signature.
Events are deduplicated and processed idempotently.

### Development

Set `COMMERCE_PAYMENT_PROVIDER=mock` (default) for testing without credentials.
Use `POST /v1/dev/commerce/complete-payment` to simulate payment completion.

### Environment variables

See `.env.example`:
- `COMMERCE_PAYMENT_PROVIDER` — `mock` or provider name
- `COMMERCE_WEBHOOK_SECRET` — HMAC secret for webhook verification
- Provider-specific credentials (production only)

## Boundaries

- No ticket sales or event commerce
- No digital marketplace (music stays in the streaming catalog)
- No third-party sellers
- No offline commerce
- Commerce never affects playback, royalties, or subscriptions
