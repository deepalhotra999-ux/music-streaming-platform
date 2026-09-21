# Phase 17 Report — Advanced Admin Operations & Moderation

Date: 2026-09-21
Baseline: `6a821c9` (Phase 16: admin panel foundation)
Status: complete. Phase 18 was not started.

## Scope delivered

### Backend

**Moderation model** (new `moderation_reports` table, migration
`20260921230000_phase17_moderation`, applied to `musicdb` and
`musicdb_test`):

- Polymorphic target: `ARTIST` / `ALBUM` / `TRACK` + target id
- Free-form `reason` + optional `details` (stored only in the
  domain table, never in audit metadata)
- Workflow status: `OPEN` → `UNDER_REVIEW` → `RESOLVED` / `DISMISSED`;
  `RESOLVED` and `DISMISSED` are terminal
- `createdBy` / `reviewedBy` admin references, `createdAt`/`updatedAt`
- Indexes on status, target, and descending created

New endpoints (all `authenticate` + `requireRole('ADMIN')`):

- `POST /v1/admin/moderation-reports` — file a report (validates
  target exists; 404 otherwise)
- `GET /v1/admin/moderation-reports` — list with status/target-type
  filters and pagination
- `GET /v1/admin/moderation-reports/:id` — detail
- `PATCH /v1/admin/moderation-reports/:id` — edit reason/details,
  transition status along valid edges only (422 on invalid
  transition, including reopening terminal reports)

No DELETE endpoint. Reports are history; they are resolved or
dismissed, never destroyed.

**Audit instrumentation** (all writes go through the immutable
Phase 16 `admin_audit_logs`; no second audit system):

- `moderation.report.created` (facts-only metadata:
  reportTargetType, reportTargetId)
- `moderation.report.status_changed` (oldStatus, newStatus)
- `moderation.report.updated` (fields changed)
- `track.status.changed` (ADMIN takedown/restore; old/new status)
- `track.deleted`, `album.deleted`, `artist.deleted`
  (ADMIN-only paths; owner actions write no admin audit row)
- Mutation + audit writes run inside a Prisma transaction:
  if the audit write fails the mutation rolls back. Denied or
  failed mutations throw before any write, so no audit row is
  created for them.

**User management:**

- `GET /v1/admin/users/:id` — ADMIN-only detail with safe explicit
  select: account status (`deletedAt`, null = active), timestamps,
  owned artists; excludes password hashes, tokens, secrets
- `GET /v1/users?includeDeleted=true` — ADMIN-only; surfaces
  soft-deleted accounts (default still hides them)
- No suspension/enable/disable mutation: the model has soft-delete
  but no suspended state, and adding one would have touched auth,
  token refresh, and playback entitlement across the platform.
  The brief explicitly allowed skipping this.

### Admin SPA (`apps/admin`)

- **Moderation page** (`/moderation`): list with status and
  target-type filters + pagination; create-report behind
  confirmation; detail drawer with valid status transitions
  behind confirmation; terminal-state messaging; audit history;
  loading/empty/error states
- **Users page**: include-deleted toggle; account-status badge in
  list and detail; detail shows timestamps and owned artists;
  existing safe role change remains confirmed and audited
- **Artists page**: verification history loaded from the audit
  log; server-computed 28-day Phase 15 analytics summary
  (streams, starts, unique listeners, listening time);
  verify/unverify remains confirmed and audited
- **Catalog page**: track detail supports confirmed takedown
  (`TAKEDOWN`) and restore (`PROCESSING`); copy clarifies that
  takedown hides content from playback and delete is a soft
  delete; track/audio status and artist/album ownership shown
- Badges for moderation status and account status; consistent
  navigation; responsive desktop/tablet layout

### Design decisions

Recorded in `docs/adr/013-admin-operations-and-moderation.md`:
moderation as report workflow (not a status column on content);
facts-only audit metadata; transactional mutation+audit writes;
no suspension state; auth responses untouched; takedown enforced
by the streaming layer (READY required for playback sessions);
migration renamed to sort chronologically.

## Acceptance criteria

- [x] Users: search, filters, pagination, detail, role, account
      status, creation date, safe confirmed role changes
- [x] Artists: search/filter/pagination/detail, verification
      status + history, verify/unverify, catalog summary,
      Phase 15 analytics summary, safe catalog actions
- [x] Catalog: search/filter, publication/processing/audio
      status, ownership, confirmed unpublish/delete via
      backend-supported ADMIN actions
- [x] Moderation: smallest maintainable model with status,
      reason, timestamps, acting admin, auditable history
- [x] ADMIN-only enforcement server-side on every new endpoint;
      LISTENER/ARTIST → 403 (verified live on all new routes)
- [x] Every successful admin mutation audited; no audit row for
      denied/failed mutations; Phase 16 audit immutability intact
- [x] No secrets/tokens/passwords/raw URLs exposed
- [x] No bulk destructive actions; no permanent deletion of
      financial/audit records
- [x] Exclusions respected: no subscriptions/payments/royalties/
      payouts/DRM/CarPlay/Android Auto/AI recommendations/social
      listening/commerce/copyright-takedown workflows/AWS deploy

## Automated verification

- Backend: **212/212 tests pass** (9 files), incl. 20/20 new
  Phase 17 tests; `tsc --noEmit` clean
- Admin SPA: **32/32 tests pass** (7 files), incl. 9 new
  Moderation page tests; `tsc` clean; production build succeeds
  (65 modules, ~325 kB JS pre-gzip)
- Mobile: **384/384 tests pass** (51 suites); Expo Doctor 21/21
- Live API flow (`scripts/phase17-live-verify.ts`): **32/32 checks**
  - ADMIN moderation create/list/detail/transitions; terminal
    transition rejected (422)
  - LISTENER and ARTIST → 403 on all five new admin operations
    (moderation POST/list/detail/PATCH, admin user detail);
    unauthenticated → 401
  - Admin user detail: 200 with owned artists, no credentials;
    `includeDeleted` works
  - Track takedown → 200; taken-down track cannot start a
    playback session (409, streaming layer requires READY);
    LISTENER takedown → 403; restore → 200
  - Audit rows present for all admin mutations; LISTENER
    audit-log access → 403
  - `UPDATE` on `admin_audit_logs` blocked by trigger
  (Throwaway users were registered for the live run and
  soft-deleted afterward; moderation reports deleted; audit
  rows retained per immutability design.)

## Manual checklist (not automated)

- [ ] Browser pass of the admin SPA (moderation list/detail/
      create, user detail drawer, artist verification history,
      track takedown/restore confirmations) — no browser device
      was available in this environment; RequireAdmin guard and
      all API flows are covered by automated tests + live 403s
- [ ] Mobile device testing — unchanged from prior phases; no
      device in sandbox
- [ ] Responsive tablet layout — implemented with CSS; not
      visually verified

## Schema / API / migration changes

- `prisma/schema.prisma`: `ModerationTargetType`,
  `ModerationStatus` enums; `ModerationReport` model with
  indexes; user relations for created/reviewed reports
- Migration `20260921230000_phase17_moderation` (renamed from
  `20260921205209_phase17_moderation` so it sorts after Phase 15
  `20260921210000` and Phase 16 `20260921220000`;
  `_prisma_migrations` updated in both databases; `prisma
  migrate status` clean)
- `src/modules/audit/service.ts`: `recordAuditEvent` accepts
  `PrismaClient | Prisma.TransactionClient` (supports
  transactional mutation+audit writes)
- `src/modules/auth/schemas.ts`: optional `deletedAt` on the
  shared user schema (populated only by ADMIN-only endpoints;
  auth register/login/me responses unchanged — the auth
  module's `toPublicUser` does not serialize it)
- New routes: 4 moderation endpoints + `GET
  /v1/admin/users/:id`; `GET /v1/users` gains `includeDeleted`

## Files created

- `services/api/prisma/migrations/20260921230000_phase17_moderation/migration.sql`
- `services/api/src/modules/moderation/{schemas,service,routes}.ts`
- `services/api/tests/phase17.test.ts`
- `services/api/scripts/phase17-live-verify.ts`
- `apps/admin/src/api/moderation.ts`
- `apps/admin/src/pages/ModerationPage.tsx`
- `apps/admin/src/__tests__/ModerationPage.test.tsx`
- `docs/adr/013-admin-operations-and-moderation.md`
- `docs/PHASE-17-REPORT.md`

## Files modified

- `services/api/prisma/schema.prisma`
- `services/api/src/http/app.ts` (moderation routes registered)
- `services/api/src/modules/moderation/service.ts` (audit
  metadata facts-only; transactional writes)
- `services/api/src/modules/tracks/service.ts` (ADMIN
  `track.status.changed`, `track.deleted` audit)
- `services/api/src/modules/albums/service.ts` (ADMIN
  `album.deleted` audit)
- `services/api/src/modules/artists/service.ts` (ADMIN
  `artist.deleted` audit)
- `services/api/src/modules/users/{service,routes,schemas}.ts`
  (admin detail, includeDeleted)
- `services/api/src/modules/auth/schemas.ts` (optional
  `deletedAt`)
- `services/api/src/modules/audit/service.ts` (transaction
  client support)
- `apps/admin/src/api/{types,users,index,analytics,catalog}.ts`
- `apps/admin/src/components/{Badges,Layout}.tsx`
- `apps/admin/src/App.tsx`
- `apps/admin/src/pages/{Users,Artists,Catalog}Page.tsx`
- `apps/admin/src/__tests__/helpers.tsx`
