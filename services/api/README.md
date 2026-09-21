# services/api

Backend API — TypeScript modular monolith (Fastify + Prisma + PostgreSQL).
See `docs/ARCHITECTURE.md` and `docs/adr/` for the big-picture decisions.

## Layout

- `src/server.ts` — entrypoint (`npm run dev` / `npm start`)
- `src/config.ts` — validated env config (fails fast at boot)
- `src/db.ts` — Prisma client singleton
- `src/http/` — app assembly, RFC 7807 error handler, auth guard plugin
- `src/modules/auth/` — registration, login, refresh, logout, `GET /v1/me`
- `prisma/` — schema, migrations, dev seed

## Run

```bash
cp .env.example .env   # then set JWT_SECRET (openssl rand -base64 48)
npm run db:migrate     # apply migrations
npm run dev            # start on PORT (default 3000)
```

## Auth endpoints (Phase 3)

| Method | Path                | Auth   | Description                             |
| ------ | ------------------- | ------ | --------------------------------------- |
| POST   | `/v1/auth/register` | —      | Create account, returns user + tokens   |
| POST   | `/v1/auth/login`    | —      | Returns user + tokens                   |
| POST   | `/v1/auth/refresh`  | —      | Rotates refresh token, returns new pair |
| POST   | `/v1/auth/logout`   | —      | Revokes refresh token (idempotent)      |
| GET    | `/v1/me`            | Bearer | Current user                            |
| GET    | `/v1/health`        | —      | Liveness probe                          |

Tokens: short-lived JWT access token (15 min) + opaque rotating refresh token
(30 days). See `docs/adr/003-authentication-design.md`.

## Scripts

- `npm test` — vitest (uses `TEST_DATABASE_URL`, never the dev DB)
- `npm run typecheck` — `tsc` over `src` + `tests`
- `npm run build` / `npm start` — compile to `dist/`, run with node
- `npm run db:seed` — dev seed data (fictional placeholders, no real music)
