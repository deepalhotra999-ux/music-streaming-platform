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
apps/        ios, android — native projects (Phase 9+)
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

## What's intentionally not here yet

Auth (Phase 2), database models/migrations (Phase 2–3), any UI (Phase 9+).
Placeholders mark where each phase's code will land.
