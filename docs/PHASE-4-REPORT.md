# Phase 4 Report — Backend API

Date: 2026-09-21
Branch: `main`
Scope: REST API layer only (users, artists, artist profiles, albums, tracks,
genres, playlists, playlist tracks, likes, follows, listening history).
Excluded per instructions: mobile UI, audio streaming, HLS/CDN,
subscriptions, payments, CarPlay, artist payouts, AI/recommendations.

## Acceptance criteria

| # | Criterion | Result |
|---|-----------|--------|
| 1 | Public catalog reads (artists, albums, tracks, genres, public playlists) work with no Bearer token | ✅ |
| 2 | Publishing restricted: only ARTIST/ADMIN can create/manage artist content; listeners get 403 | ✅ |
| 3 | Ownership isolation: artists manage only their own content; cross-artist writes 403 | ✅ |
| 4 | Admin controls: genre taxonomy, user role changes, artist verification, full catalog management | ✅ |
| 5 | Users never auto-promoted to ARTIST | ✅ (role changes are admin-only, and admins cannot change their own role) |
| 6 | Request validation on every write (JSON Schema, `additionalProperties: false`) | ✅ |
| 7 | Consistent RFC 7807 `application/problem+json` errors | ✅ |
| 8 | `?page=&limit=` pagination with `{ data, pagination }` envelope on all list endpoints | ✅ |
| 9 | Private/unlisted playlists never leak to unauthorized users (404, not 403) | ✅ |
| 10 | Swagger/OpenAPI documentation served from the API | ✅ (`/docs/json`, Swagger UI at `/docs`) |
| 11 | Unit + integration tests | ✅ 39 new integration tests |
| 12 | No schema migration required (all tables exist from Phase 2/3) | ✅ |
| 13 | Phase 5 not started | ✅ |

## Endpoint matrix (45 routes)

- **Auth** (Phase 3, annotated for OpenAPI): `POST /v1/auth/register|login|refresh|logout`, `GET /v1/me`, `GET /v1/health`
- **Users**: `GET /v1/users` (admin), `GET /v1/users/:id`, `PATCH /v1/users/me`, `PATCH /v1/users/:id/role` (admin)
- **Artists**: `GET /v1/artists`, `GET /v1/artists/:id`, `POST /v1/artists`, `PATCH /v1/artists/:id`, `DELETE /v1/artists/:id`, `GET|PUT /v1/artists/:id/profile`, `GET /v1/me/artists`
- **Albums**: `GET /v1/albums`, `GET /v1/albums/:id`, `POST /v1/albums`, `PATCH /v1/albums/:id`, `DELETE /v1/albums/:id`
- **Tracks**: `GET /v1/tracks`, `GET /v1/tracks/:id`, `POST /v1/tracks`, `PATCH /v1/tracks/:id`, `DELETE /v1/tracks/:id`
- **Genres**: `GET /v1/genres`, `GET /v1/genres/:id`, `POST|PATCH|DELETE /v1/genres/:id` (admin)
- **Playlists**: `GET /v1/playlists/public`, `GET /v1/me/playlists`, `GET|POST|PATCH|DELETE /v1/playlists/:id`, `POST /v1/playlists/:id/tracks`, `PATCH|DELETE /v1/playlists/:id/tracks/:itemId`
- **Likes**: `GET /v1/me/likes`, `POST /v1/me/likes`, `DELETE /v1/me/likes/:trackId`
- **Follows**: `GET /v1/me/follows`, `POST /v1/me/follows`, `DELETE /v1/me/follows/:artistId`
- **History**: `GET /v1/me/history`, `POST /v1/me/history`, `DELETE /v1/me/history`

Authorization model: ADR-004 (`docs/adr/004-phase4-api-authorization-model.md`).

## Verification

- `npm test` — **60/60 pass** (4 files): 39 new Phase 4 integration tests +
  21 pre-existing (15 auth, 1 rate-limit, 5 database). Covers public access,
  ownership isolation (403s), private playlist non-disclosure (404s),
  idempotent likes/follows, playCount increments, validation 400s,
  pagination envelopes, soft-delete invisibility, and the OpenAPI document.
- `npx tsc --noEmit -p tsconfig.check.json` — 0 errors.
- `npx eslint services/api/src services/api/tests` — 0 errors.
- `npx prettier --check src tests` — clean.
- `npm run build` — succeeds.
- No migration created or applied (verified: all Phase 4 tables/columns
  already exist; `prisma migrate` status clean).

Bugs found and fixed during verification:
1. `GET /v1/playlists/:id` never ran an auth guard, so `req.authUser` was
   always null — UNLISTED playlists returned 401 even with a valid token and
   owners got 404 on their own PRIVATE playlists. Fixed with a new
   `authenticateOptional` guard in `src/http/auth.ts`.
2. `import type { Prisma }` used at runtime (`instanceof
   Prisma.PrismaClientKnownRequestError`) threw `ReferenceError` → duplicate
   genre/ISRC returned 500 instead of 409. Fixed with value imports.
3. Two ESLint errors (`_reply` unused param; `<{}>` generic hack) fixed
   properly (removed param; declared `204: { type: 'null' }` in the schema).

## Manual testing checklist

Exercised against a live server (`node dist/server.js`, dev DB), then all
manual rows removed (verified 0 remaining):

- [x] `GET /v1/health` → `{"status":"ok"}`
- [x] `GET /v1/artists?limit=2` (no token) → 200, `{ data, pagination }` envelope
- [x] `GET /v1/artists?page=0` → 400 `application/problem+json` with field errors
- [x] Register → listener `POST /v1/artists` → 403
- [x] Promote to ARTIST (via DB) → login → `POST /v1/artists` → 201 with counts
- [x] `POST /v1/albums`, `POST /v1/tracks` → 201
- [x] `POST /v1/playlists` (PUBLIC) → 201; add track → 201, position 1
- [x] `POST /v1/me/likes` → 201, again → 200 (idempotent)
- [x] `POST /v1/me/follows` → 201
- [x] `POST /v1/me/history` (completed) → 201; track `playCount` 0 → 1
- [x] `GET /v1/playlists/:id` (no token, PUBLIC) → 200 with embedded track
- [x] `GET /docs/json` → 31 paths, 10 tags, `bearerAuth` scheme; `GET /docs/` → 200 HTML

## Files created

- `services/api/src/http/pagination.ts` — shared `?page=&limit=` parsing, `{ data, pagination }` envelope, `pageOf()` schema helper
- `services/api/src/http/authorization.ts` — `requireRole()`, `canManageArtist()`, `isAdmin()`
- `services/api/src/http/limits.ts` — `apiRateLimit()` per-route bucket
- `services/api/src/modules/summaries.ts` — shared artist/track summary shapes + mappers
- `services/api/src/modules/users/{schemas,service,routes}.ts`
- `services/api/src/modules/artists/{schemas,service,routes}.ts`
- `services/api/src/modules/albums/{schemas,service,routes}.ts`
- `services/api/src/modules/tracks/{schemas,service,routes}.ts`
- `services/api/src/modules/genres/{schemas,service,routes}.ts`
- `services/api/src/modules/playlists/{schemas,service,routes}.ts`
- `services/api/src/modules/likes/{schemas,service,routes}.ts`
- `services/api/src/modules/follows/{schemas,service,routes}.ts`
- `services/api/src/modules/history/{schemas,service,routes}.ts`
- `services/api/tests/phase4.test.ts` — 39 integration tests
- `docs/adr/004-phase4-api-authorization-model.md`
- `docs/PHASE-4-REPORT.md` (this file)

## Files modified

- `services/api/package.json` (+ lockfile) — added `@fastify/swagger`, `@fastify/swagger-ui`
- `services/api/src/config.ts` — `RATE_LIMIT_API` bucket (default 300/min/IP)
- `services/api/src/http/errors.ts` — `notFound`, `badRequest` helpers, shared `problemSchema`
- `services/api/src/http/auth.ts` — `authenticateOptional` guard
- `services/api/src/http/app.ts` — Swagger/OpenAPI registration (`/docs`, `/docs/json`), all Phase 4 route modules
- `services/api/src/modules/auth/routes.ts` — OpenAPI tags/summaries/error responses

## Known issues / follow-ups

- Rate limits are still in-memory per instance (carried over from Phase 3); move to Redis before horizontal scaling.
- Playlist item reordering uses raw float positions with no renormalization — repeated fractional inserts could eventually collide. Acceptable for now.
- `authenticateOptional` treats an invalid token as anonymous; strict routes still use `authenticate` (401).
- Seed `listening_history`/`subscriptions` rows still not fully idempotent (Phase 3 known issue, untouched).

## Commands for manual testing

```bash
cd services/api
npm run dev                       # start API (needs DATABASE_URL, JWT_SECRET)
curl http://localhost:3000/v1/health
curl "http://localhost:3000/v1/artists?page=1&limit=20"
curl http://localhost:3000/docs/json   # OpenAPI 3.0 document
# Swagger UI: http://localhost:3000/docs/
npm test                          # full suite (uses musicdb_test)
```

Phase 5 was not started.
