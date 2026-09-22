# Phase 20 Report — Subscription UX, Billing Management & Purchase Recovery

**Date:** 2026-09-21
**Baseline:** `eb85c2d` (Phase 19: Apple App Store & Google Play subscription integration)
**Status:** Complete, pending commit

## What was built

A complete user-facing subscription management and purchase-recovery
experience on top of the Phase 18/19 infrastructure. The backend remains
authoritative for subscription state and entitlement — no new backend
endpoints were required.

### Mobile subscription screen

**New:** `apps/mobile/src/subscriptions/SubscriptionScreen.tsx`

A polished subscription management screen (presented as a modal route at
`/subscription`) showing:

- **Current subscription:** status badge with icon + label (non-color-only),
  plan name, playback locked/unlocked state, billing period dates,
  renewal/expiration, trial end date when `TRIALING`, cancellation date
  when `CANCELED`, and the store provider (App Store / Google Play).
- **State-specific messaging** preserving Phase 18 semantics:
  - `CANCELED`: "loses playback immediately, even within the paid period"
  - `PAST_DUE`: locked with guidance to update payment in the store
  - `EXPIRED`/`REVOKED`: locked with resubscribe messaging
  - No subscription: "Free plan" with locked-state messaging
- **Available plans:** server-configured products with store prices from
  expo-iap (`displayPrice`). Prices are never invented — when the store
  provides no price, the UI shows "Price unavailable".
- **Purchase flow states:** purchasing, verifying (with explicit
  "playback unlocks only after verification" messaging), success, failed
  (with retry), canceled (distinct from failure).
- **Actions:** Subscribe/switch plan, Restore purchases, Refresh status,
  Manage subscription (store deep link, shown for APPLE/GOOGLE only).
- **Help section:** explains that billing is managed by the store, not the app.

### Purchase recovery

**Enhanced:** `apps/mobile/src/subscriptions/purchases.ts`

Added `recoverPending()` to the purchase flow — a silent reconciliation
that:

1. Checks the store for available purchases via `getAvailablePurchases()`.
2. Sends each token to the backend for verification (never assumes
   entitlement from local state).
3. Triggers `onVerified` (server state refresh) if anything verified.
4. Returns `true`/`false`; stays silent on the normal "nothing to recover"
   case and on store unavailability.

The `SubscriptionScreen` runs recovery once on mount and shows a
non-blocking notice when purchases were recovered. Unlike the
user-initiated `restore()`, recovery never sets an error for "no purchases
found".

### Subscription status

The existing `useSubscription` hook (Phase 18) already distinguishes all
states. Phase 20 surfaces them explicitly:

- ACTIVE, TRIALING, PAST_DUE, CANCELED, EXPIRED, REVOKED, none — each with
  distinct icon, label, color, and messaging.
- Verification-pending: the purchase flow's `verifying` state shows
  "Verifying purchase…" with explicit messaging that playback unlocks only
  after server verification.
- Phase 18 entitlement semantics preserved: CANCELED immediately
  non-entitled, PAST_DUE fail-closed, EXPIRED/REVOKED non-entitled. The UI
  never infers entitlement — it only displays the server's `entitled` flag.

### Billing management

**New:** `apps/mobile/src/subscriptions/manageSubscription.ts`

`openStoreSubscriptionManagement()` deep-links to the official store UI:

- **iOS:** `deepLinkToSubscriptions()` with no arguments (App Store
  subscription management).
- **Android:** `deepLinkToSubscriptions({ skuAndroid, packageNameAndroid })`
  with the SKU from the server's product mapping and the package name from
  the app config. Throws a clear error when no SKU is configured.
- Never claims a cancellation happened — only opens the store UI. The
  screen refreshes server state after the user returns.

### Profile integration

**Modified:** `apps/mobile/src/screens/ProfileScreen.tsx`

Added a "Manage subscription" button that navigates to `/subscription`.
The existing at-a-glance `SubscriptionCard` and quick-subscribe flow are
preserved.

**New route:** `apps/mobile/src/app/subscription.tsx` (modal presentation),
registered in the authenticated section of the root layout.

### Accessibility

- All interactive controls have `accessibilityRole="button"` (via Button).
- **Enhanced:** `Button` now accepts `accessibilityLabel` and
  `accessibilityHint` props (additive change).
- Status indicators use icon + text label, never color alone.
- Key screens and alerts use `accessibilityRole="alert"` and
  `accessibilityRole="header"`.
- Touch targets: Button sizes `md` (44pt min) and `lg` (52pt min) meet
  minimum guidelines.
- Dynamic text: uses the theme's font scale (no fixed pixel text).

### Backend

**No changes.** The Phase 18/19 API already supports everything Phase 20
needs:

- `GET /v1/subscriptions/me` — subscription + entitlement
- `GET /v1/subscriptions/me/entitlement` — lightweight entitlement check
- `GET /v1/subscriptions/products` — server-configured store products
- `POST /v1/subscriptions/verify-purchase` — server-side verification

No new endpoints, no schema changes, no migration. The brief's backend
requirements (auth, safe DTOs, RFC 7807, no client mutation of state) are
satisfied by the existing API.

## Acceptance criteria

- [x] Polished subscription screen: state, plan, products, prices (from
      store), trial info, billing period, renewal/expiration, locked-state
      messaging.
- [x] Purchase flows: start, pending, verifying, success, failed, canceled.
- [x] Restore purchases (explicit) and silent recovery (on screen mount).
- [x] Refresh subscription status from the server.
- [x] Plan transitions via the store purchase flow (where supported).
- [x] Manage subscription deep-links to App Store / Google Play; never
      reproduces store billing UI.
- [x] No invented prices or product IDs — all from server + expo-iap.
- [x] The app never assumes entitlement from local purchase state.
- [x] Verification-pending shows an explicit pending state; playback stays
      locked until the server confirms.
- [x] Verification failure keeps server entitlement unchanged with a
      retry path; no repeated submission of the same transaction.
- [x] All states distinguished: ACTIVE, TRIALING, PAST_DUE, CANCELED,
      EXPIRED, REVOKED, none, verification-pending.
- [x] Phase 18 entitlement semantics preserved (CANCELED immediate lock,
      PAST_DUE fail-closed, EXPIRED/REVOKED locked).
- [x] Profile integration: current plan, status, renewal/expiration, manage,
      restore, refresh, help.
- [x] Auth/session architecture unchanged.
- [x] Accessibility: labels, roles, hints, non-color indicators, touch
      targets, dynamic text.
- [x] Error/edge states: network, store, backend, product, pending,
      canceled, failed, verification pending/failed, expired, revoked,
      canceled, past-due, restore variants, signed-out — no crashes, no
      misleading "active" states.
- [x] Security: no client-trusted status, no client entitlement flags,
      Phase 18 checks bypassed nowhere, no credentials in source, no
      client-side admin, no arbitrary restore-entitlement controls.
- [x] No Phase 18/19 subscription semantics changed.
- [x] Playback still depends exclusively on server entitlement.

## Tests

### Mobile (new)

- **`SubscriptionScreen.test.tsx`** (14 tests):
  - Loading, active (unlocked), no-subscription (locked messaging),
    canceled (immediate-lock note), past-due (locked + payment guidance),
    expired, revoked, trialing states.
  - Error state with retry (network failure).
  - Signed-out state (`api` null).
  - Products load with store prices.
  - Manage-subscription button with App Store hint.
  - Refresh status reloads from server.
  - Accessibility labels on key controls.
- **`manageSubscription.test.ts`** (4 tests):
  - iOS deep link (no args), Android deep link (SKU + package),
    Android without SKU throws, unsupported platform throws.
- **`purchases.test.tsx`** (+4 tests, 10 total):
  - `recoverPending` verifies silently and returns true.
  - `recoverPending` silent on empty (no error, no server call).
  - `recoverPending` returns false on store unavailability.
  - `recoverPending` skips bad tokens without blocking the rest.

### Regression

- Backend: full suite must pass (no backend changes; Phase 18/19 tests
  untouched).
- Mobile: full suite must pass.
- Admin: full suite must pass (no admin changes).

## Manual checklist (requires real store accounts — not done here)

- [ ] iOS development build: purchase flow end-to-end (sandbox).
- [ ] Android development build: purchase flow end-to-end (sandbox).
- [ ] Interrupted purchase: kill app mid-purchase, relaunch, verify silent
      recovery reconciles on the subscription screen.
- [ ] "Manage subscription" opens App Store / Google Play subscriptions.
- [ ] Cancel in the store UI; verify the app shows CANCELED (locked)
      after refresh.
- [ ] Screen reader pass (VoiceOver / TalkBack) on the subscription screen.
- [ ] Dynamic Type / font scaling pass.

## Files created

- `apps/mobile/src/subscriptions/SubscriptionScreen.tsx`
- `apps/mobile/src/subscriptions/manageSubscription.ts`
- `apps/mobile/src/app/subscription.tsx`
- `apps/mobile/src/subscriptions/__tests__/SubscriptionScreen.test.tsx`
- `apps/mobile/src/subscriptions/__tests__/manageSubscription.test.ts`
- `docs/PHASE-20-REPORT.md` (this file)

## Files modified

- `apps/mobile/src/subscriptions/purchases.ts` — added `recoverPending()`.
- `apps/mobile/src/subscriptions/index.ts` — exported new modules.
- `apps/mobile/src/screens/ProfileScreen.tsx` — "Manage subscription"
      button navigating to `/subscription`.
- `apps/mobile/src/app/_layout.tsx` — registered `subscription` modal route.
- `apps/mobile/src/components/Button.tsx` — added `accessibilityLabel` /
      `accessibilityHint` props (additive).
- `apps/mobile/src/subscriptions/__tests__/purchases.test.tsx` — 4 new
      recovery tests.

## Known limitations

- No physical-device testing (no device in sandbox); store purchase,
  restore, and deep-link behavior verified only via mocks.
- `deepLinkToSubscriptions` on Android requires the SKU and package name;
  if the server has no Google product ID configured for the user's plan,
  the manage action shows a clear error.
- Silent recovery runs on subscription-screen mount, not on app startup —
  a startup-level hook would require deeper integration with the auth
  bootstrap.
- Prices come from expo-iap's `displayPrice`; if the store returns no
  details for a SKU, the UI shows "Price unavailable" rather than guessing.

## No ADR

Phase 20 introduces no new architectural decisions. It composes the
Phase 18 (provider-neutral subscriptions, server-authoritative
entitlement) and Phase 19 (store verification, product mapping)
architecture into user-facing UX. All significant decisions (fail-closed
entitlement, callbacks never grant entitlement, store-managed billing)
were recorded in ADR-014 and ADR-015.
