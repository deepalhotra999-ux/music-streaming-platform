# 004. Phase 4 API authorization model

Date: 2026-09-21
Status: accepted

## Context

Phase 4 adds the full REST surface (users, artists, albums, tracks, genres,
playlists, likes, follows, listening history) on top of the Phase 3 auth
foundation. The API needs one consistent answer to "who may do what?" before
45 routes encode it ad hoc. The user confirmed the model below explicitly on
2026-09-21; this ADR records it so later phases (streaming entitlements,
subscriptions, payouts) extend it instead of re-deciding it.

## Decision

**Public catalog reads need no token.** Artists, albums, tracks, genres, and
PUBLIC playlists are readable anonymously. (Audio playback and streaming
entitlement are explicitly deferred to later phases.)

**Publishing is restricted to ARTIST and ADMIN roles.**

- `LISTENER` — browse the public catalog, manage own playlists, like/follow,
  record listening history. Cannot create artists or publish music.
- `ARTIST` — manage only their own artist profile(s), albums, and tracks.
  Ownership is derived from `Artist.ownerUserId`; ordinary users are never
  auto-promoted to `ARTIST`.
- `ADMIN` — full catalog management, genre taxonomy, user role changes,
  artist verification.

**Ownership rules**

- Artist/album/track writes require the caller to own the artist row
  (`ownerUserId`) or be admin. Cross-artist writes return 403; writes against
  other users' playlists return 404 (never 403) to avoid leaking existence.
- Deletes are blocked (409), not cascaded, when children exist: an artist with
  albums/tracks, an album with tracks, a track in any playlist, a genre with
  tracks. Callers remove children first — no silent data loss.
- Soft delete (`deletedAt`) for user-facing content; every read filters it.

**Playlist visibility** — `PUBLIC` (anyone), `UNLISTED` (any authenticated
user; the URL is the secret), `PRIVATE` (owner only, others get 404).
`GET /v1/playlists/:id` uses an optional-auth guard (`authenticateOptional`):
it identifies the caller when a valid token is present but never rejects
anonymous requests, so one route serves all three visibilities.

**Privacy** — user email addresses are PII: visible only to the account holder
and admins, never in another user's profile response.

## Consequences

- Role checks run as `preHandler` *after* `app.authenticate`, via
  `requireRole(...)` in `src/http/authorization.ts`.
- All list endpoints share one pagination dialect (`?page=&limit=`,
  `{ data, pagination }` envelope, limit capped at 100).
- All errors stay RFC 7807 `application/problem+json` via the Phase 3
  central handler; new `notFound`/`badRequest` helpers added.
- OpenAPI 3.0 is generated from route schemas (`/docs/json`, Swagger UI at
  `/docs`); `bearerAuth` security scheme declared once.
- New per-route rate-limit bucket `RATE_LIMIT_API` (default 300/min/IP);
  auth endpoints keep their stricter Phase 3 buckets.
- No schema migration was needed: Phase 2/3 tables already model everything.
