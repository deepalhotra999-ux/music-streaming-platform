# Music Streaming Platform

Production-grade, Spotify-style music streaming platform. Monorepo, TypeScript.

See `CLAUDE.md` (working rules), `docs/ARCHITECTURE.md` (stack & design),
`docs/DATABASE.md` (data model).

## App preview

UI previews rendered from the project's real design system (`#7C5CFF` on `#0B0B0F`)
and demo catalog data (Pixel Reverie, Neon Coastline, Paper Satellites).
These are design renders, not runtime captures.
For a tappable click-through of Home, Search, Library, Profile, Artist, Album and the full
Player, open [`docs/preview.html`](docs/preview.html) in a browser.

| Home | Now Playing |
| ---- | ----------- |
| ![Waveform home screen](docs/screenshots/01-home.png) | ![Waveform now playing screen](docs/screenshots/02-player.png) |

| Artist | Library |
| ------ | ------- |
| ![Waveform artist profile](docs/screenshots/03-artist.png) | ![Waveform library](docs/screenshots/04-library.png) |

| Search | Album |
| ------ | ----- |
| ![Waveform search](docs/screenshots/05-search.png) | ![Waveform album detail](docs/screenshots/06-album.png) |

### Admin console (Admin Panel V2)

Real runtime captures of every admin feature, running against the demo API —
signed in as SUPER_ADMIN, all figures server-computed from demo data.

| Sign in | Command Center |
| ------- | -------------- |
| ![Admin sign in](docs/screenshots/admin-v2-login.png) | ![Admin Command Center](docs/screenshots/admin-v2-command-center.png) |

| Global search | Roles |
| ------------- | ----- |
| ![Admin global search](docs/screenshots/admin-v2-search.png) | ![Admin roles](docs/screenshots/admin-v2-roles.png) |

| Users | User detail |
| ----- | ----------- |
| ![Admin users](docs/screenshots/admin-v2-users.png) | ![Admin user detail](docs/screenshots/admin-v2-user-detail.png) |

| User login history | User track (listening) history |
| ------------------ | ------------------------------ |
| ![Admin user login history](docs/screenshots/admin-v2-user-login-history.png) | ![Admin user track history](docs/screenshots/admin-v2-user-app-history.png) |

| Ban user | Artists |
| -------- | ------- |
| ![Admin ban dialog](docs/screenshots/admin-v2-user-ban-dialog.png) | ![Admin artists](docs/screenshots/admin-v2-artists.png) |

| Artist detail & analytics | Catalog |
| ------------------------- | ------- |
| ![Admin artist detail](docs/screenshots/admin-v2-artist-detail.png) | ![Admin catalog](docs/screenshots/admin-v2-catalog.png) |

| Platform analytics | Moderation queue |
| ------------------ | ---------------- |
| ![Admin analytics](docs/screenshots/admin-v2-analytics.png) | ![Admin moderation](docs/screenshots/admin-v2-moderation.png) |

| Commerce | Finance — subscriptions |
| -------- | ----------------------- |
| ![Admin commerce](docs/screenshots/admin-v2-commerce.png) | ![Admin finance subscriptions](docs/screenshots/admin-v2-finance-subscriptions.png) |

| Finance — commerce | Finance — royalties |
| ------------------ | ------------------- |
| ![Admin finance commerce](docs/screenshots/admin-v2-finance-commerce.png) | ![Admin finance royalties](docs/screenshots/admin-v2-finance-royalties.png) |

| Security | Operations |
| -------- | ---------- |
| ![Admin security](docs/screenshots/admin-v2-security.png) | ![Admin operations](docs/screenshots/admin-v2-operations.png) |

| Platform config | Impersonation |
| --------------- | ------------- |
| ![Admin platform config](docs/screenshots/admin-v2-platform-config.png) | ![Admin impersonation](docs/screenshots/admin-v2-impersonate.png) |

| Releases | Audit log |
| -------- | --------- |
| ![Admin releases](docs/screenshots/admin-v2-releases.png) | ![Admin audit log](docs/screenshots/admin-v2-audit-log.png) |

## Prerequisites

- Node.js 20+ (`nvm use` picks up `.nvmrc`)
- npm 10+
- Docker Desktop (or equivalent) for local PostgreSQL + Redis

## Setup

```bash
nvm use          # or install Node 24
npm install      # install all workspace dependencies
cp .env.example .env   # optional; compose has dev defaults
npm run dev:services   # start PostgreSQL + Redis via Docker
```

## Everyday commands

| Command                | What it does                          |
| ---------------------- | ------------------------------------- |
| `npm run typecheck`    | Strict TypeScript check (no emit)     |
| `npm run lint`         | ESLint over the repo                  |
| `npm run format`       | Prettier check (CI gate)              |
| `npm run format:write` | Prettier write (fix formatting)       |
| `npm test`             | Vitest suite                          |
| `npm run dev:services` | Start local Postgres + Redis (Docker) |

## Layout

```
apps/        ios, android — native projects (Phase 9+); mobile — Expo RN app (Phase 5+)
services/    api — backend modular monolith (Phase 2+)
workers/     transcoder — audio pipeline worker (Phase 4+)
packages/    contracts — OpenAPI specs, shared types (Phase 2+)
infra/       terraform (later phases)
docs/        architecture, data model, ADRs
tests/       repo-level toolchain tests
```

## Conventions

- Strict TypeScript everywhere (`tsconfig.base.json`).
- ESLint (recommended TS rules) + Prettier; both enforced, not optional.
- REST APIs are specified in `packages/contracts` (OpenAPI) before implementation.
- No secrets in code — `.env` is gitignored; `.env.example` documents keys.

## Phase status

- Phase 1: repo scaffold, toolchain, conventions.
- Phase 2: Prisma 6 + PostgreSQL 16 data model (13 tables), migration, idempotent seed.
- Phase 3: authentication — register/login/logout, Argon2id passwords, HS256 access JWT + rotating opaque refresh tokens, `GET /v1/me`, JSON Schema validation, RFC 7807 errors, per-IP rate limits. See `docs/PHASE-3-REPORT.md`.
- Phase 4: backend API — users, artists (+profiles), albums, tracks, genres, playlists (+items), likes, follows, listening history. Public catalog reads, ARTIST/ADMIN publishing, playlist visibility (public/unlisted/private), shared `?page=&limit=` pagination, Swagger/OpenAPI at `/docs`. See `docs/PHASE-4-REPORT.md` and `docs/adr/004-phase4-api-authorization-model.md`.
- Phase 5: mobile foundation — Expo (React Native + TypeScript) app in `apps/mobile`: Expo Router navigation (splash, auth stack, bottom tabs), design-system foundation, Splash/Login/Register + Home/Search/Library/Profile placeholders, reusable API client, secure (Keychain/Keystore) session persistence, real auth against the Phase 4 API. See `docs/PHASE-5-REPORT.md` and `docs/adr/005-mobile-stack-expo-react-native.md`. Phase 6 not started.

## What's intentionally not here yet

Audio streaming, HLS/CDN, subscriptions, payments, artist payouts,
recommendations, mobile player/search/playlists (later phases). Placeholders mark where each
phase's code will land.
