# 014. Subscriptions & entitlements: lifecycle, provider boundary, and fail-closed access

Date: 2026-09-21
Status: accepted

## Context

Phase 18 builds the subscription/entitlement foundation that gates premium
playback. The Phase 18 brief requires:

- Lifecycle states: ACTIVE, TRIALING, PAST_DUE, CANCELED, EXPIRED, REVOKED.
- Server-side entitlement service; playback never trusts client flags.
- Existing 15-minute playback sessions stay valid until token expiry;
  entitlement gates only new sessions.
- Plans: Premium Individual, Family, Student (no final pricing).
- Apple/Google product IDs configurable outside business logic.
- Provider-neutral Apple/Google boundary; no real purchases yet.
- Deterministic DEV adapter separated from real verification, impossible
  to enable accidentally in production.
- ACTIVE/TRIALING allow new playback sessions; EXPIRED/CANCELED/REVOKED/
  no entitlement deny with RFC 7807.
- Past-due and period-boundary semantics tested and documented.
- No card data stored, ever.

## Decision

### Entitlement semantics (fail-closed)

`resolveEntitlement` in `services/api/src/modules/subscriptions/entitlements.ts`
is the single decision point. Every caller — playback session creation, the
current-user endpoints, admin inspection — uses it; the rules are not
duplicated.

| Status | Entitled? | Rule |
|---|---|---|
| ACTIVE | Only inside the paid period | `currentPeriodStart <= now < currentPeriodEnd`. Missing, future, or ended periods deny. |
| TRIALING | Only inside the trial window | `now < currentPeriodEnd`. Missing trial end denies. |
| PAST_DUE | **No** | Fail-closed. No grace window — a past-due subscription denies new sessions until the provider reports recovery. |
| CANCELED | **No** | Denied immediately, even inside the paid period. The brief explicitly requires CANCELED to deny new sessions. |
| EXPIRED | **No** | Never entitled. |
| REVOKED | **No** | Never entitled. |
| No subscription | **No** | `no_subscription`. |

Period boundaries are exclusive at the end: `now >= currentPeriodEnd` means
the access window has ended. Denial reasons are machine-readable
(`subscription_past_due`, `subscription_canceled`, `access_period_ended`, etc.)
and surfaced in the entitlement DTO.

**Why PAST_DUE denies:** The brief requires explicit past-due semantics but
authorizes no grace policy. Granting access during PAST_DUE would extend
premium playback to non-paying users on the basis of an undocumented
assumption. Fail-closed is the safe default; a grace window, if ever wanted,
must be an explicit product decision with a documented duration.

**Why CANCELED denies immediately:** The Phase 18 brief explicitly states
that CANCELED denies new playback sessions. Industry "access through period
end" behavior was considered and rejected for this phase — the brief is
authoritative.

### Existing sessions survive entitlement loss

Playback sessions are opaque, short-lived (15 min) tokens. The HLS delivery
routes validate only the session token; they do not recheck entitlement.
Revoking access stops NEW sessions immediately; in-flight sessions die with
their token. This is intentional: it bounds the worst case to 15 minutes and
keeps the hot HLS path free of entitlement lookups.

### Provider boundary

`NormalizedProviderEvent` is the provider-neutral event shape. The DEV
adapter (`providers.ts`) maps deterministic test events to it; APPLE and
GOOGLE adapters throw `notImplemented` today — the boundary exists, the
verifiers do not. No real purchases, no store SDKs, no webhook handlers in
this phase.

Product IDs live in the `plans` table (`apple_product_id`,
`google_product_id`, `dev_product_id`), not in business logic. The migration
seeds DEV product IDs; Apple/Google columns are NULL until deployment
configures them via direct DB update or a future admin/config surface. No
code references a literal product ID.

### DEV adapter gating

`DEV_SUBSCRIPTIONS_ENABLED=true` is rejected at startup unless
`NODE_ENV` is `development` or `test`. This is stricter than
"not production" — staging and other environments also refuse to boot with
the flag set. The DEV adapter performs zero store verification; it must be
impossible to enable outside local development and tests.

### Facts sanitization

Provider event `facts` are free-form string metadata, but `sanitizeFacts`
rejects keys matching payment/secret patterns (`card`, `payment`, `iban`,
`cvv`, `cvc`, `pin`, `secret`, `token`, `password`, etc.) with 422. This is
defense-in-depth for the "never store card information" requirement — even
the DEV adapter cannot persist card-like data.

### Safe DTOs

- `GET /v1/subscriptions/me` returns the public DTO: no `userId`, no
  `externalSubscriptionId`.
- `GET /v1/admin/users/:id/subscription` returns the admin DTO: keeps
  `userId` (admins inspect other users), omits `externalSubscriptionId`.
- `POST /v1/dev/subscription-events` returns the public DTO.
- Event history (`subscription_events.payload`) never leaves the server
  except as sanitized facts in the admin event list (event type + status
  transitions only).

### Append-only history

`subscription_events` has a database trigger rejecting UPDATE and DELETE
(migration `20260922000001_phase18_append_only`), matching the Phase 16
`admin_audit_logs` pattern. The `ON DELETE CASCADE` from subscriptions means
deleting a subscription with history fails rather than silently erasing
financial records. Status on `subscriptions` is a cached projection; the
event rows are the reconstructable record.

### State machine

Valid transitions are enforced server-side in `applyProviderEvent`:

- ACTIVE → PAST_DUE, CANCELED, EXPIRED, REVOKED
- TRIALING → ACTIVE, PAST_DUE, CANCELED, EXPIRED, REVOKED
- PAST_DUE → ACTIVE, CANCELED, EXPIRED, REVOKED
- CANCELED → EXPIRED, REVOKED
- EXPIRED, REVOKED → (terminal, no exits)

Invalid transitions return 422. Provider events are idempotent via the
unique `(provider, providerEventId)` constraint — duplicate deliveries
return 200 with `duplicate: true` and write no new history.

## Consequences

- New playback sessions require ACTIVE (in-period) or TRIALING (in-window).
  All other states get RFC 7807 `subscription-required` 403.
- Mobile shows a locked state when session creation returns the dedicated
  403; the cached entitlement is display-only.
- Admin inspection is read-only; no payment management surface exists.
- No royalties/earnings changes; no real payments.
