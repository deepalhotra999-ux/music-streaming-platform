# Waveform Admin (Phase 16)

Standalone admin web console for the Waveform music streaming platform.
Vite + React 19 + TypeScript single-page app. This is a **separate web
experience** — it is not part of the mobile listener app (`apps/mobile`)
and shares no code with it beyond the documented HTTP contract.

## Prerequisites

- Node.js >= 20
- The API server running (see `services/api`), reachable at `VITE_API_URL`
- An `ADMIN` account (sign in is blocked for LISTENER/ARTIST roles by the
  `RequireAdmin` guard; the server enforces roles on every admin endpoint)

## Setup

```bash
cd apps/admin
npm install
cp .env.example .env   # then set VITE_API_URL
```

## Scripts

| Script              | What it does                                 |
| ------------------- | -------------------------------------------- |
| `npm run dev`       | Start the dev server (http://localhost:5174) |
| `npm run build`     | `tsc --noEmit` + production build to `dist/` |
| `npm run typecheck` | Strict TypeScript check                      |
| `npm run lint`      | ESLint                                       |
| `npm run format`    | Prettier check                               |
| `npm run test`      | Vitest suite (jsdom + Testing Library)       |
| `npm run preview`   | Serve the production build locally           |

## Environment

| Variable       | Default                 | Purpose             |
| -------------- | ----------------------- | ------------------- |
| `VITE_API_URL` | `http://localhost:3000` | Base URL of the API |

## What it does

- **Dashboard** — catalog totals (via `limit=1` pagination totals), track
  status breakdown, and server-computed platform overview for a range
  selector (7d/28d/90d/all).
- **Users** — search, role filter, paginated table, detail view, role
  changes via `PATCH /v1/users/:id/role` behind a confirmation dialog.
  Credentials and tokens are never displayed.
- **Artists** — search, verified filter, paginated table, detail view,
  verify/unverify via `PATCH /v1/artists/:id {verified}` behind a
  confirmation dialog.
- **Catalog** — tabbed artists/albums/tracks browser with search and status
  filters, detail views, and delete actions (existing `DELETE` endpoints
  only), each behind a confirmation dialog. No new publishing workflows,
  no bulk operations.
- **Analytics** — range selector + platform overview. Numbers are
  displayed **verbatim** from the server; the app performs no analytics
  math of its own.
- **Audit Log** — read-only paginated table with action/actor/target
  filters. Immutable: no edit or delete controls exist.

## Auth model

Uses the **existing** auth system — no second authorization scheme:

- `POST /v1/auth/login` → token pair stored in `localStorage`
- `GET /v1/me` after login to load the identity (and on app bootstrap)
- `ApiClient` injects `Authorization: Bearer`, and on a 401 performs one
  `POST /v1/auth/refresh` retry per request; if refresh fails the session
  is cleared
- `POST /v1/auth/logout` is best-effort on sign-out
- `RequireAdmin` is UX-only: unauthenticated → `/login`;
  authenticated non-ADMIN → explicit "Access denied — admin only" screen.
  The server remains authoritative.

## Notes

- Standalone package: own `package.json` + lockfile, not in the root npm
  workspaces (same pattern as `apps/mobile`).
- Errors are RFC 7807 `problem+json`, surfaced as typed `ApiError`.
- Every page implements loading / empty / error-with-retry states.
- Destructive actions require explicit confirmation (`ConfirmDialog` +
  `useConfirm`); there are no multi-select destructive actions anywhere.
