# Local Demo Guide — Music Streaming Platform

**LOCAL DEMO ONLY.** Everything in this guide runs on your machine with
synthetic audio, fictional data, and mock/dev providers. No production
credentials, no real payments, no App Store / Play Console required.

> **First command to run:**
> ```bash
> cd ~/workspace/services/api && npm run demo:setup
> ```
> Then follow the steps below.

---

## 1. Prerequisites

| Requirement | Why | Check |
|-------------|-----|-------|
| Node.js ≥ 20 | Backend, mobile tooling | `node --version` |
| PostgreSQL 16 | Database | `pg_isready -h localhost -p 5432` |
| ffmpeg | Synthetic demo audio (HLS) | `ffmpeg -version` |
| Docker (optional) | Alternative Postgres via `npm run dev:services` | `docker --version` |

**PostgreSQL options:**
- **Docker:** From the repo root: `npm run dev:services` (starts Postgres + Redis)
- **Local install:** Any PostgreSQL 16 on `localhost:5432`

The demo database defaults to `musicdb` / user `music` (see
`services/api/.env.example`). The setup script refuses to run against
anything that looks like a production RDS instance.

## 2. Installation

```bash
# Backend deps
cd ~/workspace/services/api && npm install

# Mobile deps (separate — Expo standalone package)
cd ~/workspace/apps/mobile && npm install

# Admin deps
cd ~/workspace/apps/admin && npm install
```

## 3. Environment Setup

```bash
cd ~/workspace/services/api
cp .env.example .env
# Edit .env: set DATABASE_URL and JWT_SECRET (generate with: openssl rand -base64 48)
```

Minimum `.env` for the demo:
```
DATABASE_URL=postgresql://music:music@localhost:5432/musicdb
JWT_SECRET=<output of openssl rand -base64 48>
```
Leave everything else at defaults: local audio storage, mock commerce
provider, dev subscription provider. **Do NOT set Stripe/Apple/Google keys.**

## 4. Demo Database Setup (one command)

```bash
cd ~/workspace/services/api && npm run demo:setup
```

This runs, in order:
1. Prerequisite checks (Postgres reachable, ffmpeg present)
2. `prisma migrate deploy` — applies all 17 migrations
3. `prisma db seed` — base fictional catalog
4. `prisma/demo-seed.ts` — demo accounts + rich demo data
5. `scripts/generate-dev-audio.ts` — synthesized HLS audio for every READY track

**Safety:** refuses to run with `NODE_ENV=production`; refuses if
`DATABASE_URL` looks like RDS.

To re-seed only the demo data later: `npm run demo:seed`.

## 5. Backend Startup

```bash
cd ~/workspace/services/api && npm run dev
# → http://localhost:3000  (Swagger: http://localhost:3000/docs)
```

## 6. Mobile Startup

```bash
cd ~/workspace/apps/mobile && npx expo start
```

**API URL configuration** (`EXPO_PUBLIC_API_URL`, bundle-time):

| Target | Command |
|--------|---------|
| iOS simulator / web | `npx expo start` (defaults to `http://localhost:3000`) |
| Android emulator | `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000 npx expo start` |
| Physical device (same Wi-Fi) | `EXPO_PUBLIC_API_URL=http://<your-lan-ip>:3000 npx expo start` |

Find your LAN IP with `ip addr` (Linux) / `ipconfig` (Windows) / `ifconfig` (macOS).

## 7. Admin Startup

```bash
cd ~/workspace/apps/admin && npm run dev
# → http://localhost:5173
```

Override the API URL if needed: `VITE_API_URL=http://<host>:3000 npm run dev`.
Defaults to `http://localhost:3000`. Server-side authorization is never
bypassed — the demo admin must sign in with the admin demo account.

## 8. Demo Credentials (LOCAL ONLY)

Password for all three: **`Demo1234!`**

| Role | Email | Use for |
|------|-------|---------|
| Listener | `demo.listener@example.local` | Full product walkthrough, DEV premium subscription active |
| Artist | `demo.artist@example.local` | Artist dashboard, owns "Pixel Reverie" |
| Admin | `demo.admin@example.local` | Admin console (users, catalog, moderation, audit) |

These credentials only work against your local database. The production
build refuses to boot with dev providers enabled.

## 9. Suggested 10–15 Minute Demo Walkthrough

### STEP 1 — Sign in as listener
Open the mobile app, sign in as `demo.listener@example.local` / `Demo1234!`.

### STEP 2 — Browse Home/catalog
Home shows new releases, artists, featured playlists, and the genre grid.
Open the "Pixel Reverie" artist page → album "Demo Frequencies".

### STEP 3 — Search
Search for "Sine" → find "Sine Sunrise". Search is debounced across
artists/albums/tracks/genres/playlists.

### STEP 4 — Play a synthetic track
Tap "Sine Sunrise". Audio is a locally synthesized sine tone (distinct
frequency per track) streamed as HLS through a short-lived playback
session. Mini-player appears.

### STEP 5 — Open the full player
Tap the mini-player → full player modal: seek bar, queue, repeat/shuffle.

### STEP 6 — Playlists, likes, follows
Open Library → "Demo Drive Mix" (pre-made). Like a track, follow
"Pixel Reverie". Open "Demo Collab Playlist" (collaborative).

### STEP 7 — Discover
Open Discover: recommendations are computed from the demo listening
history. Try the NL discovery prompt.

### STEP 8 — Community
Open Community → the "Pixel Reverie" post ("Welcome to the local demo!")
with a demo comment. Add your own comment.

### STEP 9 — Listening room
Open Rooms → "Demo Listening Lounge" (pre-seeded with a 4-track queue).
Rooms are synchronized via WebSocket; invite flow is available in-app.

### STEP 10 — Artist mode
Sign out, sign in as `demo.artist@example.local`. Open the Artist tab:
dashboard, "Demo Frequencies" album, 4 READY tracks, analytics (plays,
listeners, trend chart), and the "Pixel Reverie Merch" store with the
"Demo Tee" product.

### STEP 11 — Commerce (mock checkout)
As the listener, open the artist store → "Demo Tee" → checkout.
**The mock payment provider is used — no real charge.** Verify the order
appears in the artist's orders list.

### STEP 12 — Admin
Open http://localhost:5173, sign in as `demo.admin@example.local`.
Tour: dashboard, users (3 demo accounts), artists, catalog, moderation
queue, audit log (append-only — every admin action is recorded),
commerce overview, platform analytics.

> **Mock/dev labels:** subscription events use the DEV provider
> (`DEV_SUBSCRIPTIONS_ENABLED`); commerce checkout uses the mock provider.
> Both are clearly labeled in the UI and **cannot** run in production —
> the API fails fast at startup if misconfigured.

## 10. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `demo:setup` fails on Postgres | Start Postgres: `npm run dev:services` (repo root) or start local PG16 |
| `demo:setup` fails on ffmpeg | Install ffmpeg for your OS |
| `COMMERCE_PAYMENT_PROVIDER=mock may only be used...` | Set `NODE_ENV=development` (or `test`) in `.env` |
| Mobile can't reach API (Android emulator) | Use `EXPO_PUBLIC_API_URL=http://10.0.2.2:3000` |
| Mobile can't reach API (physical device) | Use your LAN IP; ensure firewall allows port 3000 |
| No audio plays | Re-run `npm run audio:generate`; check `storage/audio/` exists |
| Login fails | Re-run `npm run demo:seed`; check the DB wasn't wiped |
| Port 3000 in use | Stop the other server or set `PORT=3001` (+ update app URLs) |

## 11. Known Local Limitations

- **No physical-device features proven here:** background audio, lock-screen
  controls, CarPlay, Android Auto, VoiceOver/TalkBack need real hardware.
- **Single-instance:** rate limits, metrics, and the ingestion queue are
  in-memory. Fine for demo; not production architecture.
- **Synthetic audio only:** sine tones, 30s per track. No real music.
- **Mock commerce:** checkouts never touch Stripe. Live verification is a
  separate launch step.
- **DEV subscriptions:** no Apple/Google involved. Store setup is a
  separate launch step.
