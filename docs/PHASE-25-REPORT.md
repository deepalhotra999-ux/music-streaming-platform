# Phase 25 Report — Offline Downloads & Offline Playback

**Date:** 2026-09-22
**Baseline:** Phase 24 commit `f3a5362`
**Status:** Complete, pending real-device validation before any
production-readiness claim.

## What was built

**Backend** (`services/api/src/modules/offline/`):

- `POST /v1/offline/downloads/authorize` — server-minted download
  authorizations: same gates as playback sessions (track exists, not
  deleted, READY; TAKEDOWN → 409; entitlement via
  `checkPlaybackEntitlement`, 403 otherwise). Opaque 32-byte delivery
  tokens, hash-only storage, idempotent per (user, track) — a live row
  gets its token rotated without extending the window.
- Token-scoped download delivery: master/rendition/segment routes with
  per-request token + current-track-streamability checks, Range/206/416
  segment support.
- `POST /v1/offline/downloads/:id/revalidate` — extends the 30-day
  window only while entitled; `CANCELED` keeps but never extends;
  `PAST_DUE`/`EXPIRED`/`REVOKED`/absent fail closed. Version mismatch
  marks downloads stale.
- `POST /v1/offline/downloads/:id/revoke` — explicit revocation.
- `POST /v1/playback/offline-events` — idempotent upload (max
  500/batch) with strict validation: ownership, authorization-window
  containment, revocation, track match, duration bounds, per-session
  sequence in `occurredAt` order (one START/COMPLETE, no heartbeat
  before START or after COMPLETE, one authorization/track per session
  key). Backward seeks allowed — Phase 15's 35s listening-time clamp
  makes position games unprofitable, and a time gate would false-reject
  legitimate seek-then-finish flows.
- Synthetic server-side `PlaybackSession` per `(userId,
offlineSessionKey)` (`tokenHash = null`, never usable for streaming);
  `PlayEvent.sessionId` stays non-null; `createdAt` copies `occurredAt`.
  Offline completed sessions join Phase 15 session/stream/royalty
  analytics unchanged.
- `Track.audioVersion` (default 1), incremented on successful
  replacement only. Migration
  `20260922140000_phase25_offline` (applied to `musicdb` +
  `musicdb_test`).

**Mobile** (`apps/mobile/src/offline/`):

- `DownloadManager`: bounded concurrency (2), segment-granular
  pause/resume, low-storage preflight before authorization is minted,
  per-track dedupe, crash-safe records (incomplete downloads are never
  playable).
- Package format: HLS segments concatenated into one MPEG-TS file in
  app-private storage; byte-verified before being marked playable.
- `OfflineProvider` (one manager per sign-in, crash recovery on mount,
  sync on unmount stop), `sync.ts` (flush + revalidate on startup-online
  and false→true transitions), durable AsyncStorage event queue with
  idempotent upload.
- Engine integration through the shared `PlaybackEngine` — offline
  driver status, offline events routed to the queue, Now Playing cleared
  on teardown. No second player.
- Two-tier metadata: authorization-critical records in SecureStore
  (written only from server responses); UI/download state in
  AsyncStorage.
- CarPlay and Android Auto controllers regression-tested against the
  shared engine (offline resolution, no streaming session minted, one
  player).

## Acceptance criteria

- [x] Download authorization is server-minted, entitlement-bound,
      expiring, revocable, distinct from playback tokens.
- [x] No permanent public audio URLs; no raw source audio; no
      credentials stored with media.
- [x] Downloaded media stays in app-private storage.
- [x] Partial downloads are never playable.
- [x] Track replacement invalidates the pinned version → re-download.
- [x] Offline events are local until sync, idempotent on upload, and
      join Phase 15 analytics/royalty semantics unchanged.
- [x] One shared `PlaybackEngine`; concurrency bounded at 2.
- [x] Client subscription state never trusted for authorization
      decisions.

## Tests

- Backend offline suite: **37/37 passed**.
- Full backend: **361 passed / 1 failed** — the failure is the known
  pre-existing `tests/analytics.test.ts > trend > buckets plays by UTC
day` (expected `byDate[d1]` to be `0`, received `undefined`), left
  untouched per phase protocol.
- Mobile: **77 suites, 574/574 tests passed** (includes 7 new sync
  tests, 5 new OfflineProvider tests, CarPlay/Android Auto offline
  regressions, offline engine tests).
- TypeScript, ESLint, Prettier clean; expo-doctor 20/21 (pre-existing
  direct `expo-modules-core` pin, unchanged from Phase 24); admin
  36/36 + build green; backend build green.

## Manual checklist

- [ ] Real Android device: offline playback, concatenated-TS
      compatibility, memory behavior on long downloads,
      interrupted/background downloads, low-storage behavior, lock-screen /
      Now Playing, app relaunch, account switching, expiry/revocation while
      offline, `Crypto.randomUUID()` runtime support.
- [ ] Real iOS device: same list.
- [ ] CarPlay head unit / Android Auto DHU: offline playback behavior.
- [ ] No production-readiness claim until the above are evidenced.

## Honest limitations

- The concatenated MPEG-TS package is **unproven on real devices**; it
  also assembles segments in memory. Prove it with expo-audio on
  physical Android/iOS or switch behind the same source-resolver
  abstraction to a local HLS package.
- App-private storage is not DRM; rooted/jailbroken devices can extract
  the audio file.
- The server verifies offline events _could_ have happened (right user,
  track, window, plausible sequence), not that playback physically
  occurred — offline playback cannot be cryptographically proven
  without DRM/device attestation.
- CarPlay/Android Auto browse still needs network; only already
  resolved/queued downloaded playback works offline.

## Files created

- `services/api/src/modules/offline/` (routes, service, tests)
- `services/api/prisma/migrations/20260922140000_phase25_offline/`
- `apps/mobile/src/offline/` (manager, stores, sync, queue, provider,
  UI, tests)
- `docs/adr/019-offline-downloads.md`
- `docs/OFFLINE-DOWNLOADS.md`
- `docs/PHASE-25-REPORT.md`

## Files modified

- `services/api/prisma/schema.prisma` (audioVersion, offline tables,
  nullable session tokenHash, offline session/event linkage)
- `services/api/src/modules/ingestion/service.ts` (audioVersion bump
  on successful replacement)
- `apps/mobile/src/playback/PlaybackEngine.ts` (offline driver status,
  offline event routing, teardown Now Playing)
- Mobile screens wiring download controls (Library, album/playlist
  detail, catalog lists)

Phase 26 was not started, per the user boundary.
