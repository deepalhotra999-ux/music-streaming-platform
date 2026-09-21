# Phase 16 Report — Admin Panel Foundation

Date: 2026-09-21
Base: `9590b5d` (Phase 15)
Status: **complete** (stopping here per phase discipline; Phase 17 not started)

## Scope delivered

The authorized Phase 16: a separate, dedicated web Admin Panel foundation
for ADMIN users, plus a minimal append-only audit-log foundation on the
backend. Built strictly inside the brief:

- Existing backend authentication reused (login/refresh/logout,
  `GET /v1/me`); ADMIN authorization stays server-side and authoritative
  (`authenticate` + `requireRole('ADMIN')`, `canManageArtist`); no second
  authorization system.
- Admin UI is a standalone SPA (`apps/admin`, Vite + React 19 + strict
  TypeScript, own lockfile — same standalone pattern as `apps/mobile`).
- Almost entirely existing Phase 4/15 APIs; exactly one new endpoint:
  `GET /v1/admin/audit-logs`.
- RFC 7807 errors and server-side input validation preserved; no
  passwords/tokens/secrets exposed.
- Explicit confirmation for destructive actions; no bulk operations.
- Append-only audit: new `admin_audit_logs` table + DB trigger rejecting
  UPDATE/DELETE; read-only HTTP surface; no UI to mutate audit history.
- `apps/mobile` untouched (`git status --short apps/mobile` empty).

Explicitly excluded per the brief (not built): subscriptions, payments,
royalties, artist payouts, DRM, CarPlay/Android Auto, AI recommendations,
social listening, marketplace/commerce, advanced moderation,
takedown/copyright workflows, production AWS deployment, Phase 17.

## Backend changes

New module `services/api/src/modules/audit/` (`service.ts`,
`schemas.ts`, `routes.ts`), registered in `src/http/app.ts`:

- `GET /v1/admin/audit-logs` — ADMIN-only, paginated (`page`/`limit`),
  filterable by `actorId`, `action`, `targetType`, `targetId`. Response
  item: `id`, `actorId`, `action`, `targetType`, `targetId`, `metadata`,
  `createdAt`. **No** POST/PUT/PATCH/DELETE audit routes exist (a test
  asserts they 404).
- `recordAuditEvent({ actorId, action, targetType, targetId, metadata })`
  — service-layer only, never exposed over HTTP.
- `admin_audit_logs` table (migration
  `20260921220000_phase16_audit`, applied to `musicdb` and
  `musicdb_test`): `id` (uuid PK), `actor_id` (FK users,
  `ON DELETE SET NULL`), `action`, `target_type`, `target_id`,
  `metadata` (jsonb, default `{}`), `created_at`. Indexes on
  `created_at`, `action`, `actor_id`. No update/delete timestamps.
- `admin_audit_logs_no_mutation` trigger: raises an exception on any
  UPDATE or DELETE — immutability holds even against direct DB access.
- Instrumented existing privileged actions (facts-only metadata, never
  credentials/tokens):
  - `users/service.ts` `changeUserRole` → `user.role.changed`
    `{ oldRole, newRole }` (self-role-change stays 403, writes nothing).
  - `artists/service.ts` `updateArtist` → `artist.verified`
    `{ verified: true }` / `artist.unverified` `{ verified: false }`
    (only when the flag actually flips; denied attempts write nothing).
- OpenAPI gained an `Admin` tag for the new endpoint.

Two bugs found and fixed during this phase's own verification:

1. **Audit metadata dropped over HTTP.** The response schema declared
   `metadata: { type: 'object' }` with no properties; fast-json-stringify
   serializes that as `{}` — the DB held the right value but the API
   returned empty metadata. Fixed with `additionalProperties: true`
   (`services/api/src/modules/audit/schemas.ts`) plus an HTTP-level
   regression assertion in `tests/admin.test.ts`.
2. **Admin ApiClient sent `Content-Type: application/json` on bodyless
   requests**; Fastify rejects empty JSON bodies with 400, breaking
   bodyless DELETEs (artist/track deletes from the panel). Client now
   sends the header only when a JSON body is present
   (`apps/admin/src/api/client.ts`), with two regression tests.

## Admin web app (`apps/admin`)

Standalone package (not in root workspaces), `VITE_API_URL` (defaults to
`http://localhost:3000`), README documents setup/build.

- API client: Bearer injection, one 401 refresh-and-retry, RFC 7807
  `ApiError` mapping.
- Auth: existing login/refresh/logout + `GET /v1/me`; tokens in memory
  with refresh persistence; `RequireAdmin` guard — unauthenticated →
  login, LISTENER/ARTIST → explicit access-denied screen with logout
  (server remains authoritative).
- Sections (protected nav): **Dashboard** (user/artist/album/track
  totals, published/unpublished counts, Phase 15 platform overview shown
  without client-side reinterpretation), **Users** (search, role filter,
  pagination, details, confirmed role changes), **Artists** (search,
  verified filter, pagination, details, confirmed verify/unverify),
  **Catalog** (artists/albums/tracks tabs, search/filter/status, only
  existing management actions with confirmations, no bulk ops),
  **Analytics** (range selector, server-computed Phase 15 metrics),
  **Audit Log** (read-only pagination + filters, no mutation UI).
- Shared `ConfirmDialog`: destructive actions run only after explicit
  confirmation.

## Verification

### Automated

- Backend: **192/192 pass** (8 files), incl. 17 Phase 16 admin/audit
  tests — auth/authorization on all admin routes, listings, filters,
  verification flows, audit creation with metadata, trigger immutability
  (update/delete rejected), absent mutation routes, denied attempts
  writing no rows.
- Backend `tsc --noEmit` clean; ESLint clean; Prettier clean on all
  Phase 16 files. (10 pre-existing untouched files from older phases
  fail `prettier --check` under the installed Prettier 3.9.8; left alone
  deliberately — unrelated to this phase.)
- Admin web: **23/23 pass** (6 files) — auth header, 401 refresh/retry,
  RFC 7807 mapping, Content-Type regression tests, RequireAdmin
  ADMIN/LISTENER/ARTIST/unauthenticated routing, confirmation
  cancel/accept, dashboard loading/error/retry, user search/pagination,
  artist verification only after confirmation. `tsc`, ESLint, Prettier
  all clean. `npm run build` succeeds (production bundle).
- Mobile: **384/384 pass** (51 suites), `tsc`/lint clean,
  `expo-doctor` **21/21**, no mobile source changes.

### Live end-to-end (real API, 2026-09-21)

20/20 scripted checks passed against `npm run dev` on `musicdb` with
fresh ADMIN/LISTENER/ARTIST throwaway accounts (roles promoted via the
dev-only `scripts/set-user-role.mjs`):

- ADMIN: `/v1/me` role ADMIN; user listing with pagination; audit-log
  listing; role change LISTENER→ARTIST (200); `user.role.changed` audit
  row with `{ oldRole: 'LISTENER', newRole: 'ARTIST' }` and correct
  actor/target; artist create (as ARTIST) → ADMIN verify (200) →
  `artist.verified` row with `{ verified: true }`; platform overview
  (200, numeric streams).
- LISTENER: 403 on audit-logs, user listing, platform overview, role
  change, artist verify.
- ARTIST: 403 on audit-logs and user listing.
- Unauthenticated: 401 on audit-logs.
- No audit row written for the denied verify attempt.
- Audit metadata contains only role names/booleans — no
  secrets/tokens/PII (verified in DB and over HTTP).
- Cleanup: artist row deleted (204). Throwaway user rows remain in
  `musicdb` (no user-delete endpoint by design; the admin actor row must
  stay because the append-only trigger pins referenced actors).
- API log showed no errors; server stopped after verification.

### Manual checklist (from the brief)

- [x] Full backend + mobile + admin test suites run
- [x] Typecheck / lint / format on changed code
- [x] Expo Doctor 21/21
- [x] Admin production build succeeds
- [x] Live ADMIN flow ok; LISTENER/ARTIST denied (403); audit recorded
      with correct metadata
- [x] Architecture documented (ADR-012)
- [ ] Real-browser pass over the served admin build — **not achieved**:
      the managed browser task could not navigate to the localhost URL
      (kept landing on a search page after three steers) and was closed.
      Route protection is covered by automated RequireAdmin tests
      (ADMIN renders, LISTENER/ARTIST get the access-denied screen,
      unauthenticated redirects) and by the live API flow proving the
      server is authoritative (valid LISTENER/ARTIST tokens still get 403
      on every admin endpoint, so bypassing client guards yields no
      data). Recommend a human click-through of the served `dist/` build
      before any demo.

## Files created

- `services/api/prisma/migrations/20260921220000_phase16_audit/migration.sql`
- `services/api/src/modules/audit/{service,routes,schemas}.ts`
- `services/api/tests/admin.test.ts`
- `docs/adr/012-admin-panel-and-audit-log.md`
- `docs/PHASE-16-REPORT.md` (this file)
- `apps/admin/`: `README.md`, `package.json`, `package-lock.json`,
  `eslint.config.mjs`, `index.html`, `tsconfig.json`, `vite.config.ts`,
  `vitest.config.ts`, `src/App.tsx`, `src/main.tsx`, `src/index.css`,
  `src/vite-env.d.ts`,
  `src/api/{analytics,artists,audit,auth,catalog,client,index,types,users}.ts`,
  `src/auth/AuthContext.tsx`,
  `src/components/{Badges,ConfirmDialog,DataStates,Layout,Pagination}.tsx`,
  `src/hooks/useApiList.ts`,
  `src/pages/{AnalyticsPage,ArtistsPage,AuditLogPage,CatalogPage,DashboardPage,LoginPage,UsersPage}.tsx`,
  `src/utils/format.ts`, 6 test files + setup/helpers under
  `src/__tests__/`

## Files modified

- `services/api/prisma/schema.prisma` — `AdminAuditLog` model + relation
- `services/api/src/http/app.ts` — audit routes + OpenAPI Admin tag
- `services/api/src/modules/users/service.ts` — `user.role.changed`
  instrumentation
- `services/api/src/modules/artists/service.ts` — `artist.verified` /
  `artist.unverified` instrumentation
- `services/api/tests/phase4.test.ts` — trigger-aware scoped cleanup
  (disables `admin_audit_logs_no_mutation` before deleting the suite's
  own audit rows, re-enables after)
- `services/api/src/modules/audit/schemas.ts` — metadata
  `additionalProperties: true` (bug fix)
- `apps/admin/src/api/client.ts` — conditional Content-Type (bug fix)
- `apps/admin/src/__tests__/client.test.ts` — Content-Type regression
  tests
- `services/api/tests/admin.test.ts` — HTTP-level metadata regression
  assertion (new file, extended during verification)

## Known limitations

- **Hard-delete of an audited user fails.** The immutability trigger
  rejects UPDATE, so PostgreSQL's `ON DELETE SET NULL` on `actor_id`
  cannot maintain existing audit rows either. Production code
  soft-deletes users; a hard `DELETE` of a user who acted as an audit
  actor will fail at the DB. No erasure workflow is designed in this
  phase (documented in ADR-012).
- Audit coverage is intentionally narrow: role changes and artist
  verification flips only. Extending coverage is additive (one
  `recordAuditEvent` call per action).
- Admin panel has no real-browser verification in this environment (see
  manual checklist).
- Throwaway live-test user rows remain in `musicdb` (documented above).
- Pre-existing Prettier drift in 10 untouched older-phase files (listed
  above); not reformatted to keep the diff scoped.
- `feed/`, `goals/`, `memory/`, `your_files/` remain untracked harness
  directories, as at baseline.

## Commit

Phase 16 committed on top of `9590b5d` (Phase 15). Phase 17 not started.
