# 012. Separate admin web app with append-only audit log

Date: 2026-09-21
Status: accepted

## Context

Phase 16 builds the first admin surface for the platform: a dedicated web
Admin Panel for ADMIN users (user management, artist verification, catalog
oversight, platform analytics, audit review). The brief imposed hard
constraints that shaped every decision:

- The existing backend auth must be reused; ADMIN authorization stays
  server-side and authoritative; no second authorization system.
- LISTENER and ARTIST must not reach admin API operations or data.
- `apps/mobile` stays unchanged except genuinely necessary shared code.
- Prefer existing Phase 4 APIs; add backend endpoints only when required.
- RFC 7807 errors and server-side input validation everywhere.
- Never expose passwords, tokens, or secrets.
- Destructive actions need explicit confirmation; no bulk destructive ops.
- Minimal append-only audit foundation (none existed).
- No UI to edit/delete audit history.
- Hard exclusions: subscriptions, payments, royalties, payouts, DRM,
  CarPlay/Android Auto, AI recommendations, social listening,
  marketplace/commerce, advanced moderation, takedown/copyright
  workflows, production AWS deployment.

## Decision

1. **Separate standalone SPA, not a mobile screen.** `apps/admin` is a
   Vite + React 19 + strict TypeScript package with its own lockfile,
   following the `apps/mobile` standalone pattern (root workspaces do not
   include `apps/*`). An admin console has different navigation, data
   density, and session expectations than a consumer mobile app; bolting
   it into the mobile router would have coupled two products with
   different release and access profiles.

2. **Reuse auth, keep authorization server-side.** The SPA uses the
   existing login/refresh/logout flow and `GET /v1/me` (Bearer injection,
   one 401 refresh-and-retry, RFC 7807 `ApiError`). A `RequireAdmin`
   route guard redirects unauthenticated users to login and shows an
   explicit access-denied screen with logout to LISTENER/ARTIST — but it
   is defense-in-depth UX only. Every admin operation is enforced by the
   existing `authenticate` + `requireRole('ADMIN')` middleware and
   `canManageArtist` ownership checks; the server is authoritative.

3. **Prefer existing APIs; one new endpoint.** The panel is built almost
   entirely on existing routes (user list/search/role change, artist
   search/filter/update, catalog management reads, Phase 15 platform
   overview). The single new endpoint is `GET /v1/admin/audit-logs`
   (ADMIN-only, paginated, filterable by actor/action/target). No
   POST/PUT/PATCH/DELETE exists for audit rows at the HTTP layer.

4. **Append-only audit at three depths.** New `admin_audit_logs` table
   (actor, action, target type/id, JSON metadata, timestamp; no
   update/delete timestamps; indexes on created_at, action, actor). A
   PostgreSQL trigger rejects every UPDATE/DELETE on the table, so
   immutability holds even against direct DB access — the service layer
   exposes no mutation methods and the HTTP surface exposes only reads.
   Only existing privileged actions are instrumented: `user.role.changed`
   (`{oldRole, newRole}`) and `artist.verified` / `artist.unverified`
   (`{verified}`). Denied/forbidden attempts write nothing.

5. **Metadata is facts-only and shaped by serialization.** Audit metadata
   carries non-sensitive facts only (role names, booleans) — never
   credentials, tokens, or PII beyond what the caller already exposes.
   A real bug found in live verification: the response schema declared
   `metadata: { type: 'object' }` with no properties, which
   fast-json-stringify serializes as `{}` — silently dropping metadata
   over HTTP while the DB held the right value. Fixed with
   `additionalProperties: true` plus an HTTP-level regression test.

6. **Client sends Content-Type only with a body.** The admin ApiClient
   initially set `Content-Type: application/json` unconditionally;
   Fastify rejects empty bodies declared as JSON with 400, which broke
   bodyless DELETEs. The client now sends the header only when a JSON
   body is present (regression-tested). The same pattern applies to any
   future API client.

## Consequences

- Immutability has a sharp edge: because the trigger rejects UPDATE,
  PostgreSQL's `ON DELETE SET NULL` cannot null out `actor_id` on
  existing rows either. Production code soft-deletes users, but a hard
  `DELETE` of a user who acted as an audit actor will fail at the DB.
  Documented as a known limitation; no erasure workflow is designed in
  this phase.
- Test cleanup must disable the trigger (`ALTER TABLE ... DISABLE
  TRIGGER`) before deleting seeded rows, as the admin test suite does.
- Audit coverage is intentionally narrow (role changes, verification
  flips). Extending it to more actions is additive: one
  `recordAuditEvent` call per action, no schema change.
- `apps/mobile` is untouched (verified: `git status --short apps/mobile`
  empty, 384/384 tests green).
