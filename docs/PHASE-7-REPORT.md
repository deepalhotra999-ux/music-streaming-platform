# Phase 7 Report — Streaming Infrastructure

Date: 2026-09-21
Status: **complete** (stopping here per phase discipline; Phase 8 not started)

## Scope delivered

Development streaming foundation only. The API can now issue short-lived
playback sessions and serve HLS audio through them; no permanent public audio
URL exists anywhere. Explicitly excluded per the brief: mobile player UI,
background playback, lock-screen controls, CarPlay, offline downloads,
subscriptions, payments, royalty calculations, recommendations.

- **Storage abstraction** — `src/modules/streaming/storage.ts`:
  `AudioStorage` interface (`stat` / `getObject` with byte ranges / `exists`)
  plus a `createSignedUrl` seam for the future. Provider-agnostic key scheme
  `tracks/<trackId>/hls/...`. `LocalFileStorage` driver ships for development;
  `AUDIO_STORAGE_DRIVER=s3` fails fast at startup until the S3 + CloudFront
  provider is implemented. Key validation rejects path traversal at the
  storage boundary.
- **HLS structure** — `src/modules/streaming/hls.ts`: pure playlist rewriting
  (stored relative URIs → session-scoped API URLs), structural validation
  (`#EXTM3U` check), and a master-playlist builder. One `128k` AAC rendition
  in development; the layout already supports more.
- **Playback sessions** — `src/modules/streaming/service.ts`:
  `POST /v1/playback/sessions` (auth) → availability check (exists, not
  soft-deleted, `READY`) → entitlement check → asset-exists check → opaque
  32-byte token (SHA-256 hash stored, raw token shown once; 15-min TTL
  default). Every manifest/segment fetch re-validates the token; invalid and
  expired tokens both yield 401.
- **Delivery routes** — `GET /v1/playback/hls/master.m3u8`,
  `GET /v1/playback/hls/:rendition/index.m3u8`,
  `GET /v1/playback/hls/:rendition/:segment` (all `?token=`). Manifests are
  rewritten with session URLs and served `no-store`; segments support
  `Range` (206 + `Content-Range`, 416 when unsatisfiable, `Accept-Ranges`)
  and are cached immutable. Served bodies leak no track ids or paths.
- **Entitlement placeholder** — `src/modules/streaming/entitlements.ts`:
  allows all playback in development with a real 403 enforcement point;
  denial paths are tested by stubbing the module. Phase 8 replaces the body
  with a subscription lookup, no route changes.
- **Play events** — `play_events` table (append-only: START / HEARTBEAT /
  COMPLETE / ERROR + `positionMs`) and
  `POST /v1/playback/sessions/:id/events` (auth, caller-owned sessions only;
  other users' sessions read as 404). Separate from `listening_history`;
  the royalty/fraud foundation for later phases.
- **Dev audio** — `scripts/generate-dev-audio.ts` (`npm run audio:generate`):
  synthesizes 30s HLS packages per READY track with ffmpeg's `sine` source
  (distinct frequency per track; locally controlled test audio only, never
  copyrighted). Output under `services/api/storage/` (gitignored).
- **Config** — `AUDIO_STORAGE_DRIVER`, `AUDIO_STORAGE_DIR`,
  `PLAYBACK_SESSION_TTL_SECONDS`, `RATE_LIMIT_STREAMING` (generous bucket:
  players fetch many segments); documented in `.env.example`. No production
  credentials in the repo.
- **Mobile** — `src/api/playback.ts`: thin `createPlaybackSession` /
  `reportPlayEvent` wrappers + types, contract-tested. No player UI.
- **Docs** — ADR-006 (`docs/adr/006-streaming-hls-playback-sessions.md`).

## Acceptance criteria → results

| Criterion | Result |
|---|---|
| HLS-based audio streaming architecture | ✅ VOD HLS, AAC-LC/TS, session-gated |
| Development audio assets only | ✅ ffmpeg-synthesized sine tones; no copyrighted audio |
| Audio storage abstraction | ✅ `AudioStorage` interface + local driver; S3 seam reserved |
| HLS manifest/segment structure | ✅ `tracks/<id>/hls/{master, <rendition>/index + segments}` |
| Secure playback URL architecture | ✅ opaque short-lived session tokens; playlists rewritten at serve time |
| Backend endpoint for playback session/URL | ✅ `POST /v1/playback/sessions` → `{ id, token, expiresAt, hlsUrl }` |
| Track entitlement check placeholder | ✅ allow-all with real 403 enforcement point (stub-tested) |
| Play-event architecture | ✅ append-only `play_events` + events endpoint |
| Streaming error handling | ✅ RFC 7807: 400/401/403/404/409/416 across the surface |
| Range/seek support | ✅ 206 + `Content-Range` on segments; 416 when unsatisfiable |
| CDN/storage abstraction for S3 + CloudFront later | ✅ interface + key scheme + `createSignedUrl` seam; driver fails fast |
| No production credentials/secrets in repo | ✅ tokens are opaque hashes; `.env` gitignored; only `.env.example` committed |
| API never exposes permanent public audio URLs | ✅ verified: no track id / storage path in served bodies |
| No player UI / background / offline / subs / payments / royalties / recommendations | ✅ none built |
| Tests (availability, entitlement, session creation, invalid track, expired/invalid sessions, streaming errors) | ✅ 40 backend + 3 mobile contract tests |
| tests / typecheck / lint / build | ✅ all green (backend + mobile) |

## Verification (all green, 2026-09-21)

Backend (`services/api`):

- `npm test` — 5 suites, **100 tests passed** (60 pre-existing + 40 new
  `tests/streaming.test.ts`)
- `npm run typecheck` — clean
- `npx eslint` (repo root, streaming scope incl. new/changed files) — clean
- `npm run build` (`tsc -p tsconfig.json`) — clean, `dist/modules/streaming/` emitted
- New tests cover: session creation (201 + shape + `hlsUrl` token embedding),
  401 without auth, 400 malformed track id, 404 unknown track, 409 for
  PROCESSING/TAKEDOWN and for READY-without-assets, 403 on stubbed
  entitlement denial; manifest/media-playlist rewriting (session URLs,
  directives preserved, no id/path leaks, `no-store`); segment bytes (200),
  closed/open/suffix ranges (206 + `Content-Range`), 416, 404 missing
  segment/rendition, 401 expired/invalid tokens on all three delivery
  routes, 400 malformed token and path traversal; play events (201,
  DB-verified ordering/fields, 401 unauthenticated, 404 cross-user, 401
  expired, 400 bad type); unit tests for `parseRange`, `rewritePlaylistUris`,
  `buildMasterPlaylist`, key layout and key-safety.

Mobile (`apps/mobile`):

- `npx jest` — 14 suites, **97 tests passed** (94 pre-existing + 3 new
  playback contract tests)
- `npm run typecheck` — clean; `npm run lint` — clean

Manual end-to-end (local API + generated dev audio, cleaned up afterwards):

1. `npm run audio:generate` → 6 HLS packages (30s, 128k AAC, 6s segments).
2. Register → `POST /v1/playback/sessions` → 201 with `id`, `token`,
   `expiresAt`, session-scoped `hlsUrl`.
3. `GET master.m3u8?token=` → rewritten master; `GET 128k/index.m3u8?token=`
   → rewritten media playlist with `#EXT-X-ENDLIST` intact.
4. Segment fetch → valid MPEG-TS/AAC (ffprobe); `Range: bytes=0-99` → 206
   with `bytes 0-99/104904`.
5. **ffprobe over HTTP on the master playlist URL** → `format_name=hls`,
   AAC, 30.02s — a real player consumes the whole chain through
   session-scoped URLs.
6. Play events START/HEARTBEAT/COMPLETE → 201, rows verified in
   `play_events`.
7. Error paths: unknown token → 401, missing token → 400, unknown
   rendition / missing segment → 404, unsatisfiable range → 416.
8. Test user, session, and events deleted; API stopped.

## Manual testing commands

```bash
cd services/api
# env must provide DATABASE_URL + JWT_SECRET (see .env.example)
npm run audio:generate            # synthesize dev HLS packages
npm run dev                       # start the API (port 3000)

# in another shell:
TOKEN=$(curl -s -X POST localhost:3000/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@test.local","password":"correct-horse-battery-123","displayName":"You"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])")
TRACK=<a READY track id>          # e.g. from GET /v1/tracks
SESS=$(curl -s -X POST localhost:3000/v1/playback/sessions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"trackId\":\"$TRACK\"}")
echo "$SESS" | python3 -m json.tool
ST=$(echo "$SESS" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
SID=$(echo "$SESS" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
curl -s "localhost:3000/v1/playback/hls/master.m3u8?token=$ST"
curl -s "localhost:3000/v1/playback/hls/128k/seg-00000.ts?token=$ST" -o seg.ts \
  && ffprobe -hide_banner seg.ts
ffprobe -hide_banner "http://localhost:3000/v1/playback/hls/master.m3u8?token=$ST"
curl -s -X POST localhost:3000/v1/playback/sessions/$SID/events \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"START","positionMs":0}'
```

## Known issues

- Expired playback sessions accumulate in `playback_sessions` until a janitor
  job is added (the `expires_at` index exists for it). No scheduler exists
  yet.
- Only one rendition (`128k`) in development; the master builder and key
  layout already support more.
- Token-in-query appears in access logs; acceptable for development.
  Production moves to CloudFront signed URLs with the same shape.
- Generated audio under `services/api/storage/` is gitignored: fresh clones
  must run `npm run audio:generate` (documented in `.env.example`).
- `LocalFileStorage.getObject` opens a second stat per fetch (via `stat()`);
  negligible for dev, revisit for the S3 driver.

## Files created

- `services/api/src/modules/streaming/storage.ts` — storage abstraction + local driver
- `services/api/src/modules/streaming/hls.ts` — playlist rewriting/validation
- `services/api/src/modules/streaming/entitlements.ts` — entitlement placeholder
- `services/api/src/modules/streaming/service.ts` — sessions, availability, play events
- `services/api/src/modules/streaming/schemas.ts` — JSON schemas
- `services/api/src/modules/streaming/routes.ts` — 5 endpoints + range parser
- `services/api/scripts/generate-dev-audio.ts` — dev HLS asset generator
- `services/api/tests/streaming.test.ts` — 40 tests
- `services/api/prisma/migrations/20260921150000_phase7_streaming/migration.sql`
- `apps/mobile/src/api/playback.ts` — session/event wrappers
- `apps/mobile/src/api/__tests__/playback.test.ts` — 3 contract tests
- `docs/adr/006-streaming-hls-playback-sessions.md`
- `docs/PHASE-7-REPORT.md` — this report

## Files modified

- `services/api/prisma/schema.prisma` — `PlaybackSession`, `PlayEvent`, `PlayEventType`
- `services/api/src/config.ts` — streaming config + `streaming` rate-limit bucket
- `services/api/src/http/limits.ts` — `streamingRateLimit()`
- `services/api/src/http/app.ts` — register `streamingRoutes`
- `services/api/.env.example` — streaming env docs
- `services/api/package.json` — `audio:generate` script
- `services/api/package-lock.json` — (script only; no dependency changes)
- `.gitignore` — ignore generated `services/api/storage/`
- `apps/mobile/src/api/types.ts` — `PlaybackSession`, `PlayEventType`
- `apps/mobile/src/api/index.ts` — export playback wrappers/types

## Decisions

- **Opaque session tokens, not JWTs** for playback: revocation/expiry is a
  DB lookup, matching the Phase 3 refresh-token pattern; no signing keys to
  manage for audio delivery.
- **Query-param tokens** (not `Authorization` headers): HLS players fetch
  segments without custom headers; same shape as future signed URLs.
- **409 (not 404/500)** when a READY track lacks audio assets: the track
  exists but isn't streamable *yet* — a client-retryable state, distinct
  from "not found".
- **Play events separate from `listening_history`**: telemetry vs.
  user-facing history, per ARCHITECTURE.md analytics guidance.
- **ASCII test fixtures** for segments: light-my-request utf8-decodes
  `res.body`, so byte-exact assertions need ASCII-safe content; real
  playability is verified manually with ffprobe instead.
- **No S3 SDK dependency yet**: the abstraction and fail-fast driver
  selection are the deliverable; the provider is a future phase.
