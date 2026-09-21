# Music Streaming Platform

Production-grade, Spotify-style music streaming platform. Monorepo, TypeScript.

See `CLAUDE.md` (working rules), `docs/ARCHITECTURE.md` (stack & design),
`docs/DATABASE.md` (data model).

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
