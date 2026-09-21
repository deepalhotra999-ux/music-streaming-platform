# Store Setup Guide — Apple App Store & Google Play

**Phase 19.** This guide covers the account-level setup required for
production store subscriptions, plus how to run everything locally
**without** store credentials.

No real purchases are needed for development or CI. The test suite uses
deterministic fixtures; the DEV provider covers local flows.

## Local / test (no credentials)

Leave all `APPLE_*` and `GOOGLE_*` env vars unset. The integrations stay
disabled:

- `GET /v1/subscriptions/products` returns plans with `null` store ids
  and `appleConfigured: false, googleConfigured: false`.
- `POST /v1/subscriptions/verify-purchase` returns **503** for
  `apple`/`google`.
- Notification endpoints return **503**.

Use the DEV provider (`POST /v1/admin/subscriptions/dev/events`) for
deterministic local subscription lifecycle testing.

## Apple App Store (production)

### 1. App Store Connect

1. Create an **In-App Purchase** key (Users and Access → Integrations →
   In-App Purchase): download the `.p8` private key, note the **Key ID**
   and **Issuer ID**.
2. Note your app's **Bundle ID**.
3. Configure **App Store Server Notifications v2** (App → App Store
   Server Notifications): point the production and sandbox URLs at
   `https://<api-host>/v1/subscriptions/notifications/apple`.

### 2. Products

Create subscription products in App Store Connect. Set the product IDs on
your plans (see "Plan mapping" below). Product IDs are conventionally
reverse-DNS, e.g. `com.waveform.premium.individual`.

### 3. Environment

```bash
# All four required; missing any disables the integration (503 on store routes).
APPLE_ENVIRONMENT=Sandbox            # or Production
APPLE_BUNDLE_ID=com.waveform.app
APPLE_KEY_ID=ABC123DEFG
APPLE_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Inline PEM or a path to the .p8 file:
APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
# or: APPLE_PRIVATE_KEY_PATH=/run/secrets/apple_private_key.p8
```

The server validates the signed transaction's `bundleId` and `environment`
against this configuration.

## Google Play (production)

### 1. Google Play Console

1. Create subscription products. Product IDs are typically lowercase with
   dots, e.g. `waveform.premium.individual`.
2. Note your app's **package name** (e.g. `com.waveform.app`).

### 2. Service account

1. In Google Cloud Console, create a service account with the
   **Google Play Android Developer** API access (via Play Console →
   Setup → API access).
2. Download the JSON key.

### 3. Real-Time Developer Notifications

1. Create a Pub/Sub topic (e.g. `play-rtdn`) and grant Play publish rights.
2. Create a push subscription targeting
   `https://<api-host>/v1/subscriptions/notifications/google?token=<shared-secret>`.
3. Link the topic in Play Console (Monetization setup → Real-time
   developer notifications).

### 4. Environment

```bash
# Both required; missing either disables the integration (503 on store routes).
GOOGLE_PACKAGE_NAME=com.waveform.app
# Inline JSON or a path to the service-account key file:
GOOGLE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
# or: GOOGLE_SERVICE_ACCOUNT_JSON_PATH=/run/secrets/google_service_account.json
# Shared secret for the RTDN push endpoint (query param `token`):
GOOGLE_PUBSUB_VERIFICATION_TOKEN=<random-32-bytes>
```

The server re-fetches subscription state from the Play Developer API on
every RTDN — the notification is only a trigger.

## Plan mapping

Store product IDs are configured on the `plan` table, not in code:

```sql
UPDATE plan SET apple_product_id = 'com.waveform.premium.individual'
  WHERE id = 'premium_individual';
UPDATE plan SET google_product_id = 'waveform.premium.individual'
  WHERE id = 'premium_individual';
-- Repeat for Family and Student plans.
```

`GET /v1/subscriptions/products` serves the mapping to the mobile app.
Unknown or ambiguous product IDs are rejected (422) — never silently
mapped.

## Mobile app

- expo-iap requires a **development build** (`eas build --profile
development` or `npx expo run:ios|android`). Expo Go cannot process
  purchases.
- The app never hard-codes product IDs; it uses
  `GET /v1/subscriptions/products`.
- Sandbox testing: use a sandbox Apple ID / licensed test account; the
  server must run with `APPLE_ENVIRONMENT=Sandbox`.

## Verification checklist

- [ ] `GET /v1/subscriptions/products` lists products with store ids.
- [ ] A sandbox purchase verifies and creates a subscription (check the
      admin view: provider, store product, VERIFIED).
- [ ] Cancel in the store → notification moves the subscription to
      CANCELED (may take minutes).
- [ ] Refund/revoke → REVOKED (terminal; no resurrection).
- [ ] Duplicate notifications are idempotent (one history row per
      provider event id).
