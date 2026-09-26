# Admin Panel V2 — Super Admin / Platform Operations Center

Date: 2026-09-26. Status: complete and verified — backend (29 new + full
suite green), admin frontend (tsc/eslint/prettier/build/66 tests green),
mobile (tsc clean, 773/773 pass, untouched by Admin V2), local demo
verified end-to-end. Ready to commit.

Admin V2 replaces the Phase 16 admin panel foundation with a full platform
operations center: named operational roles with server-enforced permission
bundles, governance over users and admin accounts, real finance/subscription/
royalty/commerce centers, a security center, audit with append-only reversal,
feature flags, typed platform settings, emergency controls, and short-lived
SUPER_ADMIN impersonation.

Hard constraints honored throughout:

- No "Phase 33", no consumer mobile-app redesign, no rewrite of working
  architecture, no unrelated business-logic changes.
- Listener, artist, playback, subscriptions, royalties, commerce, community,
  rooms, collaborative playlists, offline, and local-demo behavior preserved.
- CarPlay / Android Auto untouched.
- Production behavior stays fail-closed.
- No arbitrary SQL/code/config execution, arbitrary database editing, generic
  job/webhook execution, secrets, tokens, or raw card data anywhere.
- Sensitive operations are server-authorized, validated, reasoned, confirmed,
  audited, and reversible where practical.
- Immutable royalty, audit, and financial records stay immutable; corrections
  are append-only (new rows referencing the original, never UPDATE/DELETE).
- Real existing data only — no invented metrics, finances, terms, payout
  rules, provider behavior, jobs, or infrastructure.

## Roles and permission model

`services/api/src/http/authorization.ts` is the single authority.

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | Everything. Exclusive holder of: role management, grant management, audit reversal, impersonation, feature flags, platform settings, emergency controls. |
| `PLATFORM_ADMIN` | Broad operations bundle (no super powers). |
| `MODERATOR` | Content + report moderation, user view. |
| `SUPPORT_ADMIN` | User support: view/edit users, sessions, subscription management, commerce management. Cannot ban, cannot view security. |
| `FINANCE_ADMIN` | Finance views (subscriptions/commerce/royalties), royalty management. Cannot ban, cannot view security. |
| `CONTENT_ADMIN` | Catalog/content operations. |
| `ARTIST_ADMIN` | Artist operations. |
| `ANALYTICS_ADMIN` | Read-only analytics views. |
| `ADMIN` (legacy) | Frozen pre-Admin-V2 bundle only: `users.view`, `content.moderate`, `reports.moderate`, `audit.view`, `commerce.manage`, `royalties.manage`, `system.view`. No bans, credentials, subscription overrides, finance/security/jobs/webhooks views, role management, audit reversal, impersonation, flags, settings, or emergency controls. `toAdminAccountDto()` reports only this bundle + explicit grants. |
| `LISTENER`, `ARTIST` | Consumer roles, unchanged. |

Named roles resolve from server-defined bundles plus additive per-account
grants (`users.adminPermissions`). Every guard re-reads the database row, so
revocation and demotion take effect immediately — a demoted SUPER_ADMIN's JWT
stops passing `requireSuperAdmin()` at once.

`GET /v1/admin/me/permissions` returns the caller's `{ role, permissions }`
fresh from the DB; it is a UI hint only — every endpoint re-checks server-side.

## Migration

`services/api/prisma/migrations/20260926130000_admin_governance/migration.sql`:

- Named Admin V2 roles (enum extension).
- User governance fields: `bannedAt`, `banReason`, `bannedUntil`, `deletedAt`,
  `adminPermissions` (JSONB grant array).
- Audit reversibility: `beforeState`, `afterState`, `reversible`, `reversalOf`.
- `chargebacks` (append-only financial records).
- `login_events` (authentication history).
- Refresh-token IP / user-agent metadata.
- `feature_flags` (key, enabled, rolloutPercent, description, updatedBy).
- `platform_settings` (key → typed JSONB value).
- Artist suspension: `artists.suspended_at`, `artists.suspended_reason` (+ index).

Applied to `musicdb_test` (all migrations). Not yet applied to the dev database
— apply with `prisma migrate deploy` before running the API locally.

## Backend endpoints

Base: `/v1/admin/*`. Auth: Bearer JWT; optional-auth + per-route guards.
Conventions: sensitive writes require a `reason` (min lengths enforced);
bulk limits enforced (100 ids max); pagination via `page`/`take`.

### Command center / search / timeline

- `GET /v1/admin/command-center` — real platform metrics: users (total, new 7d,
  banned), subscriptions (by status/plan, trials, chargebacks), commerce
  (gross/refunds/net), royalties (runs, pools), moderation (open reports),
  system (jobs, webhooks, health). No invented MRR (plans carry no prices).
- `GET /v1/admin/search?q=&types=&take=` — permission-filtered global search
  over users, artists, albums, tracks, playlists, reports.
- `GET /v1/admin/timeline?limit=` — platform activity timeline.

### Governance (`src/modules/governance/`)

- `GET /v1/admin/me/permissions` — caller's effective permissions.
- `GET /v1/admin/admins` — admin accounts with bundles + grants (SUPER_ADMIN).
- `GET /v1/admin/roles` — role catalog (SUPER_ADMIN).
- `PATCH /v1/users/:id/role { role }` — role changes (SUPER_ADMIN; legacy
  `ADMIN` may only move non-admin users between consumer roles). Self-change
  blocked; last-SUPER_ADMIN demotion blocked; leaving the admin tier revokes
  the account's sessions.
- `PUT /v1/admin/users/:id/grants { permissions }` — replace additive grants
  (SUPER_ADMIN).
- `POST /v1/admin/users/:id/ban { reason }` / `POST .../unban`
- `PATCH /v1/admin/users/:id/email { email }`
- `POST /v1/admin/users/:id/password { newPassword }`
- `GET /v1/admin/users/:id/sessions`, `DELETE .../sessions/:sessionId`,
  `POST .../sessions/revoke-all`
- `GET /v1/admin/users/:id/login-history`, `GET .../app-history`
- `PATCH /v1/admin/subscriptions/:id { planId?, status?, currentPeriodEnd? }`
- `POST /v1/admin/subscriptions/:id/trial { trialDays }`
- `POST /v1/admin/subscriptions/:id/chargeback { amountCents, reason }`
  (append-only), `GET .../chargebacks`
- `POST /v1/admin/audit-logs/:id/reverse` (SUPER_ADMIN) — creates a NEW
  reversal row (`reversalOf` → original); originals are never mutated.
  Reversing a reversal is refused.

### Operations (`src/modules/ops/`)

- `GET /v1/admin/artists/:id/detail` — advanced artist view.
- `POST /v1/admin/artists/:id/suspend { reason }` / `POST .../restore` —
  suspended artists are filtered from all public list/detail endpoints.
- `POST /v1/admin/tracks/bulk-status { ids, status, reason }` —
  `READY ↔ TAKEDOWN` only, ≤100 ids, reason required, per-track audit rows
  (`track.takedown` / `track.restored` with before/after states).
- `GET /v1/admin/moderation/overview` — report counts by status/target type,
  oldest open report, recent reports. Real data only.
- `GET /v1/admin/finance/subscriptions` — counts by status/plan, trials,
  chargeback totals, recent subscription events.
- `GET /v1/admin/finance/commerce` — captured gross, refunds, net, statuses,
  recent refunds.
- `GET /v1/admin/finance/royalties` — royalty runs, pools, allocated/residual
  values, append-only adjustments.

### Security center

- `GET /v1/admin/security/overview` — session counts, recent security events.
- `GET /v1/admin/security/sessions` — active admin sessions.
- `POST /v1/admin/security/sessions/:id/revoke` — global session revocation.

### Platform visibility

- `GET /v1/admin/jobs` — visibility over existing job primitives only.
- `GET /v1/admin/webhooks` — webhook/provider event visibility (no invented
  outbound retries).
- `GET /v1/admin/health` — system health.

### Feature flags & platform settings (SUPER_ADMIN only)

- `GET /v1/admin/flags`, `PUT /v1/admin/flags/:key { enabled, rolloutPercent,
  description? }`, `DELETE /v1/admin/flags/:key` — every change audited and
  reversible; flags carry desired state only (no code execution).
- `GET /v1/admin/settings`, `PUT /v1/admin/settings/:key { value }` — typed
  keys with validation and bounds:

| Key | Type |
|---|---|
| `emergency.maintenance_mode` | boolean |
| `emergency.readonly_mode` | boolean |
| `emergency.new_signups_enabled` | boolean |
| `platform.maintenance_message` | string |
| `platform.support_email` | email string |

Unknown keys rejected. 30-second read cache, refreshed immediately after
writes. Registration honors the signup kill switch.

### Impersonation (SUPER_ADMIN only)

- `POST /v1/admin/impersonation/start { targetUserId, reason (10–500 chars),
  durationMinutes (1–30, default 5) }` — target must be active, non-banned,
  non-deleted, non-admin, and not self. Returns a short-lived JWT marked
  `imp: true`.
- `POST /v1/admin/impersonation/end` — explicit exit.
- Impersonated sessions are denied on every `/v1/admin/*` route except the
  exit endpoint. Target and initiating admin are re-read from the DB on each
  request: demoting the admin, banning/deleting the target, or expiry
  invalidates the session immediately. All impersonated actions are attributed
  to the initiating admin in the audit log.

### Audit

`recordAuditEvent()` accepts a preferred `actor` object and derives both
`actorId` and impersonation metadata. Commerce and community writers pass
`actor: user/admin`; existing `actorIdentity(actor)` remains supported.
Append-only: a DB trigger rejects UPDATE/DELETE on audit tables; reversals
are new rows.

## Emergency controls and fail-closed behavior

- **Maintenance mode**: listeners get 503 with the configured maintenance
  message; admin recovery routes keep working for SUPER_ADMIN.
- **Read-only mode**: mutation endpoints return 403 for non-admin callers.
- **Signup kill switch**: registration refused while disabled.
- Optional-auth paths re-check emergency state without swallowing
  503/403 into anonymous access (fail-closed, never fail-open).
- Settings read failures fail closed (deny) rather than serving stale-open.

## Screens (apps/admin)

Permission-aware shell: `PermissionsProvider` fetches
`GET /v1/admin/me/permissions` after login; the sidebar shows only sections
the caller's permission set reaches (SUPER_ADMIN sees all 16); 403s render a
friendly "not permitted" state. The server remains the authority.

| Route | Screen |
|---|---|
| `/` | Command Center — real metric cards from `/v1/admin/command-center`, platform timeline feed, quick links. No invented numbers. |
| `/search` | Global search — debounced query → `/v1/admin/search`, grouped results with click-through to user/artist detail. |
| `/users` | User control — search + role filter + paginated table; in-page detail with sessions (revoke one/all), login history, app/listening history, ban/unban (reason required), email/password admin actions, subscription override, trial grant, chargeback recording. Each action gated by its permission key and behind `ConfirmDialog`. |
| `/roles` | Role management (SUPER_ADMIN) — admin accounts, role changes, additive grant replacement, role catalog. Self-changes blocked in the UI (server also blocks). |
| `/artists` | Artist control — detail with suspend (reason required) / restore; bulk track status tool (ids, `READY↔TAKEDOWN` only, reason required, per-track updated/skipped results). |
| `/catalog` | Existing catalog management (unchanged flows preserved). |
| `/moderation` | Moderation center — existing report queue + overview (counts by status/target type, oldest open report). |
| `/commerce` | Existing commerce views (unchanged). |
| `/finance` | Three views — Subscriptions (counts by status/plan, trials, chargebacks), Commerce (gross/refunds/net, recent refunds), Royalties (runs, pools, allocated/residual, adjustments). Real data only. |
| `/security` | Security center — overview, active sessions table with revoke. |
| `/ops` | Jobs (read-only visibility), Webhooks (event visibility), Health, Timeline. |
| `/audit` | Audit log (existing filters) + Reverse button on reversible rows (SUPER_ADMIN only) with confirmation; reversed/reversal badges. |
| `/config` | Platform config (SUPER_ADMIN) — feature flags list/create-update/delete with validation; typed settings editor; EMERGENCY section with red confirmations for `emergency.maintenance_mode`, `emergency.readonly_mode`, `emergency.new_signups_enabled`. |
| `/impersonate` | Impersonation start (SUPER_ADMIN) — target user id, reason (10–500 chars), duration (1–30 min); shows the session token with copy. A persistent red banner renders across the whole app whenever the stored access token decodes to `imp: true` (display only): "IMPERSONATING {email} — reason — expires in mm:ss" + explicit "End impersonation" calling `POST /v1/admin/impersonation/end`. |

Existing pages (Login, Users, Artists, Catalog, Analytics, Moderation,
Commerce, AuditLog) keep their working Phase 16–31 flows.

## Security / audit / emergency controls summary

- Server-authoritative RBAC on every route; named bundles + additive grants;
  fresh DB re-reads (revocation/demotion immediate).
- Last-SUPER_ADMIN protection; self-role-change prevention.
- Sensitive writes require reasons; all audited with before/after states.
- Reversals are append-only new rows; originals immutable; double-reversal
  refused.
- Impersonation: SUPER_ADMIN-only, reason required, 1–30 min, non-admin
  targets only, admin surfaces denied, full attribution, explicit exit.
- Emergency settings: typed, validated, cached with immediate refresh,
  fail-closed enforcement.
- No arbitrary execution, no secrets/tokens/card data in admin surfaces.

## Tests

Backend (`services/api`, full HTTP stack via `app.inject()` against
`musicdb_test`):

- 29 new tests in `tests/admin-v2.test.ts`: permission boundaries (legacy
  ADMIN non-escalation, SUPPORT_ADMIN/FINANCE_ADMIN bundle limits, listener
  403s, unauthenticated 401s), impersonation (start/end, admin-route denial,
  admin/self/short-reason refusal, demotion + target-ban invalidation),
  emergency controls (maintenance 503 with admin recovery, read-only 403,
  signup kill switch, non-super-admin refusal, unknown keys), feature flags
  (CRUD, permission, validation), artist suspension (hide/restore), bulk
  track status (transitions + per-track audit), audit reversal (ban →
  reverse → unbanned; double-reversal refused; non-super-admin refused),
  my-permissions endpoint.
- Full backend suite: 710 passed, 20 files (2026-09-26, after the
  release-tooling split).
- TypeScript: `tsc --noEmit` clean.

One ordering-dependent cleanup failure was caught during final verification
and fixed: `tests/database.test.ts`'s `beforeAll` cleanup calls
`db.subscription.deleteMany()`, which cascades into the append-only
`subscription_events` table (Phase 18 `subscription_events_no_delete`
trigger). When another suite's subscription fixture rows are present, the
cascade is rejected and leftover users break `phase4.test.ts` (409 on
register). The cleanup now disables `subscription_events_no_delete` around
the subscription delete and re-enables it after — the same pattern the file
already used for `admin_audit_logs`.

Bugs caught by the new tests and fixed:

1. Bare `{ type: 'object' }` response schemas serialized every ops response
   as `{}` (fast-json-stringify drops unknown properties) — fixed with
   `additionalProperties: true` on all ops response schemas (Phase 16
   precedent).
2. `setSetting`/`setFlag`/`deleteFlag` wrote the string key into the
   UUID-typed `target_id` column → 500s; fixed to `targetId: null` with the
   key in metadata.
3. Subscription fixtures are append-only (DELETE rejected by trigger) —
   tests leave fixture rows in place.

Frontend (`apps/admin`, Vitest + Testing Library):

- 66/66 tests pass, including 7 new Admin V2 tests in
  `src/__tests__/AdminV2.test.tsx`:
  - Permission-gated nav: restricted callers see only permitted sections
    (plus always-visible Command Center/Search); fully permissioned callers
    see all sections.
  - Impersonation banner: renders IMPERSONATING warning with target email,
    reason, and live MM:SS countdown; hidden for normal tokens; "End
    impersonation" calls `POST /v1/admin/impersonation/end`.
  - Emergency controls: applying a break-glass setting opens a destructive
    confirmation dialog naming the exact key; Cancel sends nothing; Confirm
    sends exactly one `PUT /v1/admin/settings/:key`.
- Test harness (`src/__tests__/helpers.tsx`) wraps renders in
  `PermissionsProvider` with a mocked `/v1/admin/me/permissions` endpoint.
- TypeScript: `tsc --noEmit` clean. ESLint: clean. Prettier: clean.
- Production build: `npm run build` succeeds.

## Builds

- API: `tsc --noEmit` clean; `npm run build` (tsc) succeeds (2026-09-26).
- Admin: `tsc --noEmit` clean, ESLint clean, Prettier clean,
  `npm run build` succeeds (2026-09-26).
- Mobile: untouched by Admin V2 (no Admin V2 changes in apps/mobile);
  `tsc --noEmit` clean, `npx jest` 773/773 pass (2026-09-26).

## Local-demo verification

Run 2026-09-26 against the seeded demo database (`musicdb`, migration
`20260926130000_admin_governance` applied via `prisma migrate deploy`,
demo seed executed, API served on :3000, demo.admin promoted to
SUPER_ADMIN). All checks end-to-end via HTTP:

- `GET /v1/admin/command-center` → 200, real metrics (5 demo users, 12
  sections); `GET /v1/admin/me/permissions` → SUPER_ADMIN, 16 permissions.
- Ban demo.listener (204) → audit row `user.banned`, reversible → reverse
  (200) → `bannedAt` cleared.
- Impersonation start → token works as demo.listener on `/v1/me`,
  `/v1/admin/command-center` → 403, explicit end → 204.
- `emergency.maintenance_mode=true` → listener `/v1/tracks` → 503, admin
  command-center → 200; back to false → listener → 200.
- Server stopped after verification; demo left clean (listener unbanned,
  maintenance off).

## Limitations

- Mobile apps unchanged: no admin surfaces on mobile (by design).
- Royalty preview of hypothetical terms: not built (would require inventing
  payout rules).
- Webhook retry engine: not built (no invented outbound behavior).
- Generic job executor: not built (jobs surface is read-only visibility over
  existing primitives).
- No invented infrastructure, MRR, or provider behavior anywhere.
- The separately-built release tooling (EAS Update support, admin-triggered
  GitHub Actions deploy endpoints, Releases admin page, `docker-compose.prod.yml`,
  `docs/RELEASES.md`) is deliberately excluded from this commit and ships in
  its own scoped commit.
- `musicdb` (dev) needs `prisma migrate deploy` for the new migration.
