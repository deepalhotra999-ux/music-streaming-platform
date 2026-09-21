# 003. Authentication design

Date: 2026-09-21
Status: accepted

## Context

Phase 3 ships email/password authentication. The token strategy, password
hashing, and session lifecycle are security-critical and hard to change later,
so they are recorded here.

## Decision

- **Password hashing:** Argon2id via `@node-rs/argon2` (prebuilt binaries, no
  native toolchain needed). OWASP-recommended memory-hard function; beats
  bcrypt on GPU/ASIC resistance. `password_hash` is nullable on `users` so
  future social-login users can exist without a password.
- **Access tokens:** JWT, HS256, 15-minute expiry. Claims: `sub` (user id),
  `role`, `email`, `iss`/`aud`. Short-lived so no server-side revocation list
  is needed for v1.
- **Refresh tokens:** opaque 256-bit random values (base64url). Only the
  SHA-256 hash is stored (`refresh_tokens.token_hash`, unique). 30-day expiry,
  **rotated on every use**: the presented token is revoked and a new one is
  issued in the same request.
- **Reuse detection:** presenting an already-rotated (replaced) refresh token
  is treated as suspected theft — all refresh tokens for that user are revoked
  and the request fails. The user must log in again.
- **Logout:** revokes the presented refresh token. Idempotent — unknown or
  already-revoked tokens still return `204`. Access tokens are not revoked
  server-side (15-minute max lifetime is accepted).
- **Rate limiting:** per-IP limits on auth endpoints
  (login 10/min, register 20/min, refresh/logout 60/min) via
  `@fastify/rate-limit`. In-memory store for now; Redis-backed store before
  multi-instance deployment.
- **Error semantics:** login and refresh failures return `401` with an
  identical problem body whether the email is unknown or the password is
  wrong — no user enumeration. Duplicate registration returns `409`.
- **Validation:** Fastify JSON Schema (ajv) on all auth request bodies.
  Password policy: 12–128 characters. Email: RFC format, max 254 chars.

## Consequences

- Clients store the refresh token securely (httpOnly cookie on web, Keychain /
  Keystore on mobile — client phases decide) and rotate it via
  `POST /v1/auth/refresh`.
- `email_verified` defaults to `false`; verification emails are a later phase.
- A managed OIDC provider (per ARCHITECTURE.md) may replace or complement this
  in a later phase; the `users.auth_subject` column is reserved for that.
- Token TTLs and rate limits are config (`src/config.ts`), overridable by env.
