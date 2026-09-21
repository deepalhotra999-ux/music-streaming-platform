# Phase 19 Report — Apple App Store & Google Play Subscription Integration

**Date:** 2026-09-21
**Baseline:** `3c8a25d` (Phase 18: subscriptions & entitlements)
**Status:** Complete, pending commit

## What was built

Production-oriented Apple App Store and Google Play subscription
integrations behind the Phase 18 provider-neutral boundary.

### Backend

**Configuration** (`services/api/src/config.ts`):

- Apple: `APPLE_ENVIRONMENT` (sandbox/production), `APPLE_BUNDLE_ID`,
  `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_PRIVATE_KEY` /
  `APPLE_PRIVATE_KEY_PATH`. All four required; missing any disables the
  integration (503 on store routes).
- Google: `GOOGLE_PACKAGE_NAME`, `GOOGLE_SERVICE_ACCOUNT_JSON` /
  `GOOGLE_SERVICE_ACCOUNT_JSON_PATH`, `GOOGLE_PUBSUB_VERIFICATION_TOKEN`.
- Invalid `APPLE_ENVIRONMENT` fails startup.

**Apple adapter** (`services/api/src/modules/subscriptions/apple/`):

- ES256 JWS parsing with x5c chain verification against Apple's roots.
- Signed-transaction binding: `bundleId` and `environment` must match
  server config.
- App Store Server API JWT + transaction lookup/subscription enrichment.
- Notifications v2 normalization: `DID_RENEW`, `DID_FAIL_TO_RENEW` →
  grace, `EXPIRED`, `REFUND`/`REVOKE` → revoked,
  `DID_CHANGE_RENEWAL_STATUS` (auto-renew off) → canceled.
- `appAccountToken`, when present, must match the authenticated user.

**Google adapter** (`services/api/src/modules/subscriptions/google/`):

- Service-account OAuth (JWT assertion, cached access token).
- `purchases.subscriptionsv2.get` verification.
- RTDN Pub/Sub parsing with timing-safe shared token comparison.
- Authoritative API re-fetch on every notification (notification is only
  a trigger).
- `linkedPurchaseToken` drives token migration without forking rows.
- `packageName` must match server config.

**Product mapping** (`productMapping.ts`): Store product IDs live on the
`plan` table (`appleProductId`, `googleProductId`). Unknown/ambiguous
mappings are 422.

**Schema** (migrations `20260922000002`, `20260922000003`):

- `Subscription.verificationStatus` (`UNVERIFIED`/`VERIFIED`),
  `Subscription.lastVerifiedAt`.
- Verified events mark rows `VERIFIED`; unverified never downgrade.
- Verified renewal resurrects `EXPIRED → ACTIVE`; `REVOKED` is terminal.

**Routes**:

- `GET /v1/subscriptions/products` — server-configured store products.
- `POST /v1/subscriptions/verify-purchase` — server-side verification;
  only verified purchases create/update subscriptions.
- `POST /v1/subscriptions/notifications/apple` — JWS-verified.
- `POST /v1/subscriptions/notifications/google` — token-verified + API
  re-fetch.
- Admin DTO: `storeProductId`, `verificationStatus`, `lastVerifiedAt`,
  `latestEvent`.

### Mobile (`apps/mobile`)

- expo-iap 5.6.3 installed (requires development build; Expo Go
  insufficient).
- `src/api/subscriptions.ts`: `getStoreProducts`, `verifyPurchase`.
- `src/subscriptions/purchases.ts`: `usePurchaseFlow` state machine —
  idle → loading-products → ready → purchasing → verifying →
  success | failed | canceled; plus restoring.
- `src/subscriptions/PurchaseSheet.tsx`: product list, purchase, restore,
  and all pending/success/failed/canceled/restored states.
- `ProfileScreen`: "Subscribe to Premium" button + purchase sheet modal.
- **Critical invariant:** a store purchase callback alone NEVER grants
  entitlement. The token goes to the backend; entitlement only changes
  after server verification and a client state refresh. The transaction
  is finished only after successful verification.

### Admin (`apps/admin`)

- Subscription view shows: provider, store product id, verification
  badge (Verified/Unverified), last verified timestamp, latest event.
- Read-only; no payment management surface.

## Acceptance criteria

- [x] Apple/Google adapters behind the provider-neutral boundary.
- [x] Apple server-side verification + Notifications v2 with signed data.
- [x] Google server-side verification + RTDN with API re-fetch.
- [x] Configurable store-product mapping; no scattered IDs.
- [x] Deterministic notification idempotency; append-only history.
- [x] Entitlement service remains playback's only authority.
- [x] Mobile purchase/restore with pending/success/failed/canceled/
      restored; callbacks never grant entitlement.
- [x] Secure notification endpoints; malformed input rejected.
- [x] Admin read-only details: provider, plan, store product, state,
      period, latest event, verification.
- [x] Secrets via environment only; RFC 7807, ADMIN auth, DEV gating
      preserved.
- [x] Deterministic fixtures/mocks; no production purchases.
- [x] Setup docs without real credentials.

## Tests

- **Backend:** 44/44 Phase 19 tests pass (Apple JWS/PKI, product mapping,
  adapter verification/notification mappings, app binding, Google OAuth/
  API fixtures, RTDN, package binding, token migration, route auth/config
  denial, idempotency, resurrection/terminal states, verification
  non-downgrade, entitlement gating, callback-only denial, admin fields).
  Phase 18: 37/37 pass.
- **Mobile:** 6/6 new purchase-flow tests pass (products from server,
  callback→verification→success, rejected verification→failed without
  finishing, cancellation→canceled, restore→verify, empty restore).
  Existing subscription tests: 9/9 pass.
- **Admin:** 4/4 subscription inspection tests pass (incl. new Phase 19
  fields test).

## Manual checklist (requires real store accounts — not done here)

- [ ] Apple: sandbox purchase verifies; admin shows VERIFIED.
- [ ] Apple: server notification moves subscription through lifecycle.
- [ ] Google: RTDN triggers API re-fetch; state updates.
- [ ] Google: linkedPurchaseToken migration on plan change.
- [ ] Mobile: development build purchase flow end-to-end.
- [ ] Duplicate notifications produce one history row each.

## Files created

- `services/api/src/modules/subscriptions/productMapping.ts`
- `services/api/src/modules/subscriptions/fetchOverride.ts`
- `services/api/src/modules/subscriptions/providerContext.ts`
- `services/api/src/modules/subscriptions/apple/jws.ts`
- `services/api/src/modules/subscriptions/apple/provider.ts`
- `services/api/src/modules/subscriptions/google/auth.ts`
- `services/api/src/modules/subscriptions/google/provider.ts`
- `services/api/prisma/migrations/20260922000002_phase19_verification/`
- `services/api/prisma/migrations/20260922000003_phase19_verification_fix/`
- `services/api/tests/phase19.test.ts`
- `apps/mobile/src/subscriptions/purchases.ts`
- `apps/mobile/src/subscriptions/PurchaseSheet.tsx`
- `apps/mobile/src/subscriptions/__tests__/purchases.test.tsx`
- `docs/adr/015-store-subscription-integration.md`
- `docs/STORE-SETUP.md`
- `docs/PHASE-19-REPORT.md` (this file)

## Files modified

- `services/api/prisma/schema.prisma`
- `services/api/src/config.ts`
- `services/api/src/http/errors.ts`
- `services/api/src/modules/subscriptions/providers.ts`
- `services/api/src/modules/subscriptions/routes.ts`
- `services/api/src/modules/subscriptions/schemas.ts`
- `services/api/src/modules/subscriptions/service.ts`
- `services/api/tests/phase18.test.ts` (cleanup trigger handling)
- `services/api/.env.example`
- `apps/mobile/src/api/types.ts`
- `apps/mobile/src/api/subscriptions.ts`
- `apps/mobile/src/api/index.ts`
- `apps/mobile/src/subscriptions/index.ts`
- `apps/mobile/src/screens/ProfileScreen.tsx`
- `apps/mobile/package.json` (expo-iap)
- `apps/admin/src/api/types.ts`
- `apps/admin/src/pages/UsersPage.tsx`
- `apps/admin/src/__tests__/SubscriptionInspection.test.tsx`

## Remaining account/sandbox/device work

Per the brief, the following are outside this phase's code work and
require real store accounts:

1. Apple App Store Connect: In-App Purchase key, bundle ID, notification
   URL, subscription products.
2. Google Play Console: subscription products, service account, Pub/Sub
   topic + push subscription.
3. Plan table: set `apple_product_id` / `google_product_id` per plan.
4. Mobile: EAS/development build (expo-iap is native; Expo Go can't run
   it).
5. End-to-end sandbox purchase verification.

See `docs/STORE-SETUP.md` for the full checklist.
