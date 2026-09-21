# Phase 3 Report — Authentication

**Date:** 2026-09-21
**Status:** Complete. Phase 4 not started.

## Scope (as requested)

Built: user registration, login, logout, password hashing, access/refresh
tokens, authentication guards, input validation, basic rate limiting,
authentication tests.

Explicitly **not** built (per request): social login, subscriptions, music
streaming, mobile UI, CarPlay, anything else.

## Acceptance criteria

| # | Criterion | Result |
|---|-----------|--------|
| 1 | `POST /v1/auth/register` creates a user with an Argon2id hash, returns user + token pair, rejects duplicates (409, case-insensitive email) | ✅ tested + manual |
| 2 | `POST /v1/auth/login` returns user + token pair; unknown email, wrong password, deleted account, and passwordless account all return identical 401 (no enumeration) | ✅ tested + manual |
| 3 | Passwords hashed with Argon2id (`@node-rs/argon2`); plaintext never stored or returned | ✅ tested (hash format asserted) |
| 4 | Short-lived JWT access tokens (15 min, HS256, `jose`) + opaque rotating refresh tokens (30 days, 256-bit, SHA-256 hash stored) | ✅ tested |
| 5 | `POST /v1/auth/refresh` rotates: old token revoked, replacement issued atomically; reuse of a rotated token revokes the whole family (theft response) | ✅ tested + manual |
| 6 | `POST /v1/auth/logout` revokes the token, idempotent (unknown/already-revoked → 204) | ✅ tested + manual |
| 7 | `GET /v1/me` guarded by Bearer JWT; rejects missing/malformed/tampered/expired tokens and deleted accounts | ✅ tested + manual |
| 8 | Request validation via Fastify JSON Schema (email format, password 12–128, display name 1–80); failures → 400 RFC 7807 | ✅ tested + manual |
| 9 | Per-IP rate limits on auth endpoints (login 10/min, register 20/min, refresh/logout 60/min); 429 as RFC 7807 | ✅ tested + manual |
| 10 | Errors are RFC 7807 `application/problem+json` via a central handler | ✅ tested + manual |

## Design (see ADRs)

- `docs/adr/002-http-framework-fastify.md` — Fastify, JSON Schema validation,
  RFC 7807 errors, `@fastify/rate-limit` (in-memory store for now).
- `docs/adr/003-authentication-design.md` — Argon2id, HS256 access JWT (15
  min), opaque refresh tokens (30-day, hash-only storage, rotation, reuse =
  family revocation), 12–128 char passwords, generic login failures.

## Files created

- `services/api/src/config.ts` — validated env config, fails fast at boot
- `services/api/src/http/errors.ts` — RFC 7807 problem helpers + central
  error handler (400/401/403/404/409/422/429/500)
- `services/api/src/http/auth.ts` — `authenticate` guard plugin (Bearer JWT
  verification, `req.authUser`)
- `services/api/src/http/app.ts` — app assembly, rate-limit plugin, routes,
  `/v1/health`
- `services/api/src/modules/auth/passwords.ts` — Argon2id hash/verify
- `services/api/src/modules/auth/tokens.ts` — JWT creation, opaque refresh
  token generation + SHA-256 hashing
- `services/api/src/modules/auth/service.ts` — register/login/refresh/logout
  domain logic (no HTTP concerns)
- `services/api/src/modules/auth/schemas.ts` — JSON Schema bodies + responses
- `services/api/src/modules/auth/routes.ts` — route handlers, error mapping
- `services/api/src/server.ts` — entrypoint, graceful shutdown
- `services/api/tests/auth.test.ts` — 15 tests
- `services/api/tests/rate-limit.test.ts` — 1 test
- `services/api/.env.example`, `services/api/tsconfig.check.json`
- `docs/adr/002-http-framework-fastify.md`, `docs/adr/003-authentication-design.md`
- `docs/PHASE-3-REPORT.md` (this file)
- `services/api/prisma/migrations/20260921113817_phase3_auth/migration.sql`

## Files modified

- `services/api/prisma/schema.prisma` — `User.passwordHash`,
  `RefreshToken` model (uuid pk, unique token hash, expiry/revocation/
  replacement timestamps, cascade on user delete, user index)
- `services/api/prisma/migrations/20260921081734_phase2_foundation/migration.sql`
  — added `CREATE EXTENSION IF NOT EXISTS citext;` (the original migration
  assumed the extension existed; it failed on fresh databases)
- `services/api/package.json` — deps (`fastify`, `@fastify/rate-limit`,
  `jose`, `@node-rs/argon2`), `dev`/`start` scripts, typecheck covers
  `src` + `tests`
- `services/api/vitest.config.ts` — test JWT secret, single-thread
- `services/api/README.md` — rewrote (was stale: "no code yet")
- `docs/DATABASE.md` — `password_hash` + `refresh_tokens` entity
- `.gitignore` — `.pgdata/`
- `package-lock.json`

## Verification

| Check | Result |
|-------|--------|
| API tests (`npm test` in `services/api`) | 21/21 pass (15 auth, 1 rate-limit, 5 pre-existing Phase 2 db tests) |
| Root tests | 5/5 pass |
| API typecheck (`src` + `tests`) | clean |
| Root typecheck | clean |
| ESLint (root + api) | clean |
| Prettier check | clean |
| API build (`tsc`) | clean |
| Migration `phase3_auth` applied to `musicdb` (dev) and `musicdb_test` | ✅ |

## Manual testing checklist (all performed against local dev server)

- [x] `GET /v1/health` → `{"status":"ok"}`
- [x] Register → 201, email normalized to lowercase, user + token pair returned
- [x] Duplicate register (same/case-variant email) → 409
- [x] Invalid email / short password / missing fields → 400
- [x] Login wrong password and unknown email → identical 401 bodies
- [x] `GET /v1/me` without token → 401; bad token → 401; good token → 200
- [x] Refresh → 200 with new pair; old token reuse → 401 and replacement
      token also dead (family revocation)
- [x] Logout → 204; repeat logout → 204; refresh after logout → 401
- [x] Unknown route → 404 RFC 7807 body
- [x] 4th login in a 3/min window → 429 RFC 7807 body

## Known issues / follow-ups (not in scope for Phase 3)

1. **Rate-limit store is in-memory** — correct for one instance; needs Redis
   before running multiple API instances (ADR-002).
2. **No background purge of expired/revoked refresh tokens** — expired rows
   are deleted lazily when encountered. Add a scheduled purge later.
3. **Login timing side-channel** — unknown-email logins skip Argon2
   verification, so response bodies are identical but timing may differ.
   Mitigate with a dummy hash verification if this matters.
4. **Concurrent refresh race** — two simultaneous refreshes with the same
   token could both pass the revoked-check before either revokes. The
   rotation itself is transactional; strict single-use under concurrency
   would need a conditional update/row lock.
5. **`package.json#prisma` seed config is deprecated** in Prisma 7 (works in
   Prisma 6). Migrate to `prisma.config.ts` when upgrading.
6. Phase 2 carry-overs still open: seed not fully idempotent (listening
   history, subscriptions); audit timestamps not uniform across tables.

## Environment note (2026-09-21)

The sandbox VM was replaced mid-phase, wiping the apt-installed PostgreSQL
16 and both databases. Ubuntu apt mirrors are unreachable through the
sandbox egress proxy, so Postgres was restored from the `pgserver` PyPI
package (PostgreSQL 16.2) with a hand-compiled `citext` extension, running
as the `pgserver` system user on localhost:5432 with data in
`/var/lib/postgresql/pgdata`. Role `music`, databases `musicdb` /
`musicdb_test`, `citext` enabled in both. See `TOOLS.md` for the rebuild
recipe. `docker-compose.yml` remains the canonical path on normal machines.
