# Phase 18 Report — Subscriptions & Entitlements

Date: 2026-09-21
Baseline: `dad74fc` (Phase 17: advanced admin operations & moderation)
Status: complete. Phase 19 was not started.

## Scope delivered

### Backend

**Database** (migrations applied to `musicdb` and `musicdb_test`):

- `20260922000000_phase18_subscriptions`:
  - `SubscriptionStatus` += `TRIALING`, `REVOKED`
  - New enums: `SubscriptionProvider` (`APPLE`, `GOOGLE`, `DEV`), `PlanType`
    (`INDIVIDUAL`, `FAMILY`, `STUDENT`), `SubscriptionEventType`
  - New tables: `plans`, expanded `subscriptions`, `subscription_events`
  - Unique `(provider, externalSubscriptionId)` and `(provider, providerEventId)`
  - Seeds plans: `premium_individual`, `premium_family`, `premium_student`
    (with DEV product IDs; Apple/Google IDs NULL until deployment configures)
  - Migrates legacy `premium-monthly` → `premium_individual`
- `20260922000001_phase18_append_only`:
  - Database trigger rejects UPDATE/DELETE on `subscription_events`
  - Financial history is immutable at the database level

**Modules** (`services/api/src/modules/subscriptions/`):

- `entitlements.ts` — Single decision point. `resolveEntitlement` is pure and
  unit-testable; `getEntitlement` adds the DB lookup. Fail-closed semantics:
  - ACTIVE: entitled only when `currentPeriodStart <= now < currentPeriodEnd`
  - TRIALING: entitled only when `now < currentPeriodEnd`
  - PAST_DUE: denied (no grace window — see ADR-014)
  - CANCELED: denied immediately (per brief)
  - EXPIRED/REVOKED/none: denied
- `providers.ts` — Provider-neutral `NormalizedProviderEvent`. DEV adapter
  maps deterministic test events; APPLE/GOOGLE throw notImplemented.
- `service.ts` — State machine with validated transitions; idempotent via
  unique `(provider, providerEventId)`; `sanitizeFacts` rejects
  payment/secret-like keys with 422.
- `schemas.ts` — Safe DTOs: public (no userId/externalId), admin (keeps
  userId, omits externalId), DEV result uses public DTO.
- `routes.ts` — `GET /v1/subscriptions/me`, `GET /v1/subscriptions/me/entitlement`,
  `GET /v1/admin/users/:id/subscription` (ADMIN-only), `POST /v1/dev/subscription-events`.

**Integration points:**

- Playback session creation now calls `getEntitlement`; denial returns RFC 7807
  `subscription-required` 403. Existing 15-min sessions unaffected (token-based).
- `DEV_SUBSCRIPTIONS_ENABLED=true` rejected unless `NODE_ENV` is `development`
  or `test` (stricter than "not production").
- Startup fails fast if DEV flag set in production/staging.

### Mobile (`apps/mobile`)

- `src/api/subscriptions.ts` — Typed wrappers for `/me`, `/me/entitlement`
- `src/api/types.ts` — `Subscription` (safe DTO: no userId/externalId),
  `Entitlement`, status/provider types
- `src/subscriptions/` — `useSubscription` hook (loading/error/retry,
  stale-unmount protection), `SubscriptionCard` component
- `ProfileScreen` — Subscription section with loading/error/empty states
- `PlaybackEngine` — `locked` flag when session creation returns 403;
  `FullPlayer` shows locked banner distinct from retryable errors
- Cached entitlement is display-only; server remains authoritative

### Admin (`apps/admin`)

- `getAdminUserSubscription` API wrapper
- User detail page: read-only subscription section (status badge, plan,
  provider, period, entitlement, event history)
- `SubscriptionStatusBadge` component
- Loading/error/retry/empty states; no payment controls or mutations

## Acceptance criteria

- [x] Lifecycle states ACTIVE/TRIALING/PAST_DUE/CANCELED/EXPIRED/REVOKED implemented
- [x] Auditable history preserved; no destructive overwrites (DB trigger)
- [x] No card information stored (facts sanitization + schema constraints)
- [x] Centralized server-side entitlement service (`entitlements.ts`)
- [x] Playback never trusts client flags (server-side check only)
- [x] Existing sessions valid until token expiry; entitlement gates new sessions only
- [x] Plans: Individual/Family/Student (no pricing)
- [x] Product IDs configurable in DB, not hard-coded
- [x] Provider-neutral boundary; no real purchases
- [x] DEV adapter deterministic, separated, impossible in production
- [x] Current-user API exposes no external transaction details
- [x] ACTIVE/TRIALING allow new sessions (in-period only)
- [x] EXPIRED/CANCELED/REVOKED/none deny with RFC 7807 403
- [x] Past-due denies (fail-closed, documented in ADR-014)
- [x] Period boundaries tested (exclusive end, missing period fails closed)
- [x] Admin inspection: status/plan/provider/period/entitlement, read-only
- [x] State transitions validated server-side (422 on invalid)
- [x] Provider events idempotent (duplicate → 200, no new history)
- [x] Mobile: state display, loading/error, locked playback, entitled-playback tests

## Tests

- Backend: **249/249 pass** (37 new Phase 18 tests)
  - Entitlement state matrix (ACTIVE period validation, TRIALING window,
    PAST_DUE/CANCELED immediate denial, EXPIRED/REVOKED/none)
  - Period boundaries (exclusive end, missing period fails closed)
  - State machine transitions (valid/invalid, terminal states)
  - DEV lifecycle (start → renew → payment failed → recovered → canceled → expired)
  - Trial lifecycle (start → convert → active)
  - Idempotency (duplicate events)
  - Facts sanitization (payment-like keys rejected)
  - DEV gating (production/staging refuse to boot)
- Mobile: **398/398 pass** (63 new: API wrappers, hook, card, engine locked,
  player banner)
- Admin: **35/35 pass** (new subscription inspection tests)
- Typecheck: backend, mobile, admin all clean
- ESLint: clean on changed files
- Prettier: clean on changed files
- Expo Doctor: 21/21
- Admin production build: succeeds

## Live verification

Script: `services/api/scripts/phase18-live-verify.mjs`

All checks passed:
- No subscription → 403 with RFC 7807 `subscription-required`
- DEV start → ACTIVE, entitled, playback session 201
- Expire → new sessions 403, existing HLS session still 200
- Spoofed client flags → 403 (server authoritative)
- Duplicate events → 201/200, `duplicate: true`, one history row
- Current-user DTO: no `userId`/`externalSubscriptionId` leaked
- Past-due → 403 (fail-closed verified live)
- Canceled → 403 immediately (verified live)
- Admin endpoint: ADMIN ok, LISTENER 403, unauth 401
- Catalog/search/library/moderation regressions green

Test users cleaned up; server stopped.

## API changes

**New endpoints:**
- `GET /v1/subscriptions/me` → `{ subscription: PublicSubscription | null, entitlement }`
- `GET /v1/subscriptions/me/entitlement` → `{ entitled, status, planCode, currentPeriodEnd, reason }`
- `GET /v1/admin/users/:id/subscription` → `{ subscription: AdminSubscription | null, entitlement, events }` (ADMIN-only)
- `POST /v1/dev/subscription-events` → `{ subscription, entitlement, duplicate }` (DEV-only, 404 when disabled)

**Modified:**
- `POST /v1/playback/sessions` — now returns 403 `subscription-required` (RFC 7807)
  when not entitled; 201 when entitled

**Schemas:**
- `PublicSubscription`: id, planId, plan, provider, status, period, canceledAt, timestamps
  (no userId, no externalSubscriptionId)
- `AdminSubscription`: as above + userId (no externalSubscriptionId)
- `Entitlement`: entitled, status, planCode, currentPeriodEnd, reason

## Migrations

1. `20260922000000_phase18_subscriptions` — Schema + plan seeds + legacy migration
2. `20260922000001_phase18_append_only` — Trigger blocking UPDATE/DELETE on
   `subscription_events`

Both applied to `musicdb` and `musicdb_test`. Prisma client regenerated.

## Provider boundary / DEV vs real

- `NormalizedProviderEvent` is the neutral shape all providers map to.
- DEV adapter: deterministic, in-process, zero verification. Enabled only via
  `DEV_SUBSCRIPTIONS_ENABLED=true` with `NODE_ENV=development|test`.
- APPLE/GOOGLE adapters: throw `notImplemented`. The boundary exists; the
  verifiers do not. No store SDKs, no webhooks, no real purchases.
- Product IDs: stored in `plans` table (`apple_product_id`, `google_product_id`,
  `dev_product_id`). Business logic references no literal product IDs.
  Apple/Google columns are NULL until deployment configures them.

## Limitations

- No real Apple/Google integration (by design — Phase 18 is foundation only)
- No pricing data (plans exist without prices per brief)
- No webhooks or server-to-server notifications
- Past-due has no grace window (fail-closed per ADR-014; grace would need
  explicit product decision)
- CANCELED denies immediately even in paid period (per brief; differs from
  industry "access through period end")
- Mobile not physically tested (no device in sandbox)
- Admin console not browser-tested (automated tests + live 403s cover auth)

## Files created

**Backend:**
- `services/api/src/modules/subscriptions/providers.ts`
- `services/api/src/modules/subscriptions/entitlements.ts`
- `services/api/src/modules/subscriptions/service.ts`
- `services/api/src/modules/subscriptions/schemas.ts`
- `services/api/src/modules/subscriptions/routes.ts`
- `services/api/prisma/migrations/20260922000000_phase18_subscriptions/migration.sql`
- `services/api/prisma/migrations/20260922000001_phase18_append_only/migration.sql`
- `services/api/tests/phase18.test.ts`
- `services/api/scripts/phase18-live-verify.mjs`

**Mobile:**
- `apps/mobile/src/api/subscriptions.ts`
- `apps/mobile/src/api/__tests__/subscriptions.test.ts`
- `apps/mobile/src/subscriptions/useSubscription.ts`
- `apps/mobile/src/subscriptions/SubscriptionCard.tsx`
- `apps/mobile/src/subscriptions/index.ts`
- `apps/mobile/src/subscriptions/__tests__/useSubscription.test.tsx`
- `apps/mobile/src/subscriptions/__tests__/SubscriptionCard.test.tsx`

**Admin:**
- `apps/admin/src/__tests__/SubscriptionInspection.test.tsx`

**Docs:**
- `docs/adr/014-subscriptions-entitlements.md`
- `docs/PHASE-18-REPORT.md` (this file)

## Files modified

**Backend:**
- `services/api/prisma/schema.prisma` — Subscription models, enums
- `services/api/prisma/seed.ts` — Plan reference update
- `services/api/src/config.ts` — DEV gating (development/test only)
- `services/api/src/http/app.ts` — Route registration
- `services/api/src/http/errors.ts` — `subscriptionRequired` 403
- `services/api/src/modules/streaming/entitlements.ts` — Delegates to subscription service
- `services/api/src/modules/streaming/service.ts` — Uses new entitlement check
- `services/api/.env.example` — DEV_SUBSCRIPTIONS_ENABLED documented
- `services/api/tests/database.test.ts` — Plan reference
- `services/api/tests/ingestion.test.ts` — Entitled listener fixture

**Mobile:**
- `apps/mobile/src/api/types.ts` — Subscription/Entitlement types (safe DTO)
- `apps/mobile/src/api/client.ts` — `isSubscriptionRequired` helper
- `apps/mobile/src/api/index.ts` — Export subscriptions
- `apps/mobile/src/playback/types.ts` — Locked state
- `apps/mobile/src/playback/PlaybackEngine.ts` — Locked on 403
- `apps/mobile/src/playback/__tests__/PlaybackEngine.test.ts` — Locked tests
- `apps/mobile/src/player/FullPlayer.tsx` — Locked banner
- `apps/mobile/src/player/__tests__/FullPlayer.test.tsx` — Banner test
- `apps/mobile/src/screens/ProfileScreen.tsx` — Subscription section

**Admin:**
- `apps/admin/src/api/types.ts` — AdminSubscriptionDetail (safe DTO)
- `apps/admin/src/api/users.ts` — getAdminUserSubscription
- `apps/admin/src/components/Badges.tsx` — SubscriptionStatusBadge
- `apps/admin/src/pages/UsersPage.tsx` — Subscription inspection section
