# ADR-015: App Store & Google Play Subscription Integration

**Status:** Accepted (2026-09-21)
**Phase:** 19

## Context

Phase 18 built a provider-neutral subscription and entitlement core with a
DEV provider for deterministic local testing. Real money, however, moves
through Apple App Store and Google Play. We need production store
integrations that:

1. Verify purchases server-side (never trust the client).
2. Handle lifecycle events (renewals, cancellations, billing failures,
   refunds/revocation) via store server notifications.
3. Keep the Phase 18 entitlement service as playback's only authority.
4. Support deterministic local testing without real store accounts.

## Decision

### Provider boundary

`SubscriptionProvider` gains `APPLE` and `GOOGLE` alongside `DEV`. Each
store gets a dedicated adapter module behind the Phase 18
provider-neutral boundary:

- `services/api/src/modules/subscriptions/apple/` — App Store Server API
  verification + App Store Server Notifications v2.
- `services/api/src/modules/subscriptions/google/` — Play Developer API
  verification + Real-Time Developer Notifications (RTDN) via Pub/Sub.

Adapters implement `verifyPurchase(token)` and `normalizeServerEvent(raw)`
returning a normalized `NormalizedProviderEvent` (or `null` for
authenticated no-ops like Apple's `TEST` notifications).

### Apple: signed data only

- All notification payloads are JWS (`signedPayload`). The server parses
  the ES256 signature, validates the x5c chain against Apple's roots, and
  only then trusts the payload.
- Purchase verification accepts a signed transaction JWS (or a bare
  transaction id, enriched via the App Store Server API).
- `bundleId` and `environment` from the signed transaction must match
  server configuration — a token minted for another app is rejected.
- `appAccountToken`, when present, must match the authenticated user id.
- Notification types mapped: `DID_RENEW` → renewal success,
  `DID_FAIL_TO_RENEW` → grace period, `EXPIRED` → expired,
  `REFUND`/`REVOKE` → revoked, `DID_CHANGE_RENEWAL_STATUS` (auto-renew
  off) → canceled, `GRACE_PERIOD_EXPIRED` → expired.

### Google: API re-fetch is authoritative

- RTDN messages are Pub/Sub pushes. The server validates a shared
  query-token (timing-safe compare), then **re-fetches** the subscription
  from the Play Developer API — the notification itself is only a trigger.
- Purchase verification calls `purchases.subscriptionsv2.get` with a
  service-account OAuth token.
- `linkedPurchaseToken` drives token migration (plan changes) without
  forking subscription rows.
- `packageName` from the API must match server configuration.

### Product mapping

Store product IDs live in the `plan` table (`appleProductId`,
`googleProductId`), not scattered in code. `GET /v1/subscriptions/products`
serves them to the mobile client. Unknown or ambiguous mappings are 422,
never silent.

### Verification status

`Subscription` gains `verificationStatus` (`UNVERIFIED`/`VERIFIED`) and
`lastVerifiedAt`. Verified events mark rows `VERIFIED`; unverified events
never downgrade a verified row. A verified renewal can resurrect
`EXPIRED → ACTIVE`; `REVOKED` is terminal.

### Mobile: callbacks never grant entitlement

The mobile app (expo-iap) collects the store purchase token and POSTs it
to `/v1/subscriptions/verify-purchase`. A store "purchase succeeded"
callback alone grants nothing — entitlement only changes after the
backend verifies and the client refreshes server state. The purchase
transaction is finished only after successful verification.

### Admin: read-only inspection

The admin subscription DTO gains `storeProductId`, `verificationStatus`,
`lastVerifiedAt`, and `latestEvent`. No payment management surface.

### Secrets

All store credentials come from environment/secret configuration
(`APPLE_*`, `GOOGLE_*`). Missing credentials disable the integration
(routes return 503); nothing is hard-coded.

## Consequences

- Production readiness requires Apple App Store Server API credentials
  and Google Play service-account + Pub/Sub setup (see
  `docs/STORE-SETUP.md`). These are account-level tasks outside the code.
- Local/dev testing uses the DEV provider and deterministic fixtures —
  no real purchases, no sandbox accounts needed for the test suite.
- The mobile app requires a development build (expo-iap is native);
  Expo Go cannot run purchases.
