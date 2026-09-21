# Phase 15 Report — Artist Analytics & Reporting

Date: 2026-09-21
Base: `8a1c9a7` (Phase 14)
Status: **complete** (stopping here per phase discipline; Phase 16 not started)

## Scope delivered

The authorized Phase 15: ARTIST users get server-computed analytics over
their own catalog — headline totals, a streams trend, top tracks/albums,
and recent completed plays — aggregated from the Phase 7 `play_events`
append-only stream. Explicitly excluded per the brief: royalties/payouts,
a separate analytics database/warehouse, real-time analytics
infrastructure, Phase 16.

## Metric definitions (exact)

All definitions live in `services/api/src/modules/analytics/service.ts`
and are recorded as ADR-011
(`docs/adr/011-artist-analytics-event-aggregation.md`).

- **Unit of a play:** one `playback_sessions` row. Its `created_at` is the
  canonical timestamp for date-range filtering and trend buckets (a
  session's events can straddle midnight; the play counts once, on the
  day it started).
- **Date ranges:** `7d`, `28d`, `90d`, `all`. Lower bounds are inclusive;
  `all` has no lower bound. Trend buckets are UTC day (`7d`/`28d`) or
  UTC week (`90d`/`all`).
- **Stream:** a session with ≥ 1 `COMPLETE` event. Duplicate COMPLETEs
  count once (`COUNT(DISTINCT session_id)`).
- **Start:** a session with ≥ 1 `START` event.
- **Failed play:** a session with an `ERROR` event and no `COMPLETE`.
- **Incomplete play:** a session with `START`, no `COMPLETE`, no `ERROR`.
  Failed/incomplete plays never count as streams.
- **Unique listeners:** distinct session `userId` over all in-scope
  sessions (not only completed streams) — the audience that attempted
  playback.
- **Listening time:** per session, events ordered by
  `(created_at, id)`, sum of
  `clamp(current.position_ms − previous.position_ms, 0, 35_000)` ms.
  Duplicate heartbeats contribute 0, backward seeks contribute 0, large
  forward jumps are capped at 35 s (one 30 s heartbeat interval + 5 s
  tolerance). Heartbeats alone never create a stream.

## API contract

`services/api/src/modules/analytics/` (`routes.ts`, `service.ts`,
`schemas.ts`), registered in `src/http/app.ts`:

- `GET /v1/artists/:id/analytics/overview` — headline totals
  (`streams`, `starts`, `failedPlays`, `incompletePlays`,
  `uniqueListeners`, `listeningTimeMs`) for `?range=`.
- `GET /v1/artists/:id/analytics/tracks` — per-track stats, paginated,
  ranked by streams then listening time; optional `?trackId=`.
- `GET /v1/artists/:id/analytics/albums` — per-album stats, paginated,
  ranked the same; optional `?albumId=`.
- `GET /v1/artists/:id/analytics/trend` — per-bucket
  (`?granularity=day|week`) streams/starts/outcomes/listeners/time.
- `GET /v1/artists/:id/analytics/recent` — recent completed sessions
  (track/session/time only — **no listener identity**).
- `GET /v1/analytics/platform/overview` — ADMIN-only platform totals.

**Authorization:** artist endpoints require ARTIST/ADMIN, then
`canManageArtist` ownership validation. Track/album filter ids are
validated against that artist's catalog — a foreign id returns 404,
never a misleading empty result. LISTENER → 403 on all five artist
endpoints (tested). Empty scopes return zero totals / empty lists.

**Aggregation:** one PostgreSQL query per section (CTEs + window
functions over `playback_sessions` ⋈ `play_events`); raw events are
never materialized into Node.

## Database / index changes

Migration `20260921210000_phase15_analytics` (applied to `musicdb` and
`musicdb_test`; no new tables):

- `CREATE INDEX playback_sessions_track_id_created_at_idx ON playback_sessions(track_id, created_at)`
- `CREATE INDEX play_events_created_at_idx ON play_events(created_at)`

`schema.prisma` gained the two `@@index` entries; Prisma client
regenerated.

## Mobile

- `apps/mobile/src/api/analytics.ts` — typed wrappers for all six
  endpoints; DTO/range/trend types added to `api/types.ts`, re-exported
  from `api/index.ts`.
- `apps/mobile/src/analytics/format.ts` — `formatCompact`,
  `formatTotalDuration`, `formatBucketDate` (pure, tested).
- `apps/mobile/src/screens/ArtistAnalyticsScreen.tsx` — owned-artist
  switcher, `7D/28D/90D/All` selector, stat cards (streams, listeners,
  listening time, play attempts + failed/incomplete note), bar trend
  chart, top tracks, top albums, recent completed plays; loading,
  no-artist, no-plays, error, and retry states.
- `apps/mobile/src/app/(artist)/analytics.tsx` — route in the existing
  `(artist)` ARTIST-only stack (registered in `(artist)/_layout.tsx`);
  `ArtistDashboardScreen.tsx` gained a "View analytics" action passing
  the artist id.
- The app never computes metrics; every number is server-computed.

## Verification

- **Backend:** 175/175 pass (29 new analytics tests covering: stream vs
  start semantics, duplicate-COMPLETE single counting, failed/incomplete
  exclusion, unique-listener distinctness, heartbeat math incl.
  duplicate-heartbeat-zero and 35 s forward-jump cap, backward-seek
  zero, date-range boundaries, `all`, track/album filters, foreign-id
  404s, empty scope, ARTIST/LISTENER/ADMIN authorization, cross-artist
  isolation, pagination). Typecheck, production build, ESLint, Prettier
  clean.
- **Mobile unit:** 384/384 pass (20 new: 8 API wrapper contract tests,
  6 formatter tests, 6 screen tests incl. range change, no-plays, retry,
  no-artist, initial-artist). Typecheck, ESLint, Prettier,
  `expo-doctor` 21/21, iOS + Android `expo export` all clean.
- **Live integration** (`apps/mobile/src/api/__tests__/live/analytics.live.test.ts`,
  5/5 vs the real API): throwaway ARTIST + LISTENER, one real playback
  session driven through the Phase 7 streaming endpoints
  (START@0 → HEARTBEAT@30000 → COMPLETE@60000), then verified
  `streams=1`, `starts=1`, `uniqueListeners=1`,
  `listeningTimeMs=60_000` **exactly** (heartbeat math end-to-end),
  per-track attribution, trend bucketing, recent activity with no
  listener identity, LISTENER 403 on all five endpoints, and a second
  artist seeing zeros (isolation). Test data cleaned up in `afterAll`.
- **Playback/Library regression:** full backend + mobile suites green,
  covering the Phase 8 engine, Phase 10 background audio, and Phase 11
  library tests — no regressions.

## Limitations / not physically tested

- **Listening time is a deterministic approximation**, not wall-clock
  truth: forward seeks can contribute up to the 35 s cap, missing events
  understate time, and event positions do not prove uninterrupted
  listening. Documented in ADR-011 and the report rather than hidden.
- **Event-model limits:** a session's events can straddle a bucket
  boundary but count once on the session's day; trend buckets are UTC
  (no per-timezone bucketing); unique listeners counts logged-in user
  ids only.
- **Scale:** no materialized rollups — at very large event volumes the
  per-request aggregations will need pre-aggregation (a future phase can
  add it without changing the API contract).
- **Not physically tested:** no device/SDK in the sandbox, so the
  Analytics screen's on-device rendering, chart layout, and
  navigation-while-loading were verified via component tests and
  iOS/Android exports only.
- The 35 s listening-time cap is coupled to the engine's 30 s heartbeat
  cadence; if the cadence changes, the cap must move with it.
- The live test stages a copy of seeded dev HLS audio under the
  throwaway track's storage key and flips the track READY via direct DB
  update (documented in the test) — it verifies the analytics path, not
  the ingestion pipeline.

## Files

Created:

- `services/api/prisma/migrations/20260921210000_phase15_analytics/migration.sql`
- `services/api/src/modules/analytics/service.ts`
- `services/api/src/modules/analytics/schemas.ts`
- `services/api/src/modules/analytics/routes.ts`
- `services/api/tests/analytics.test.ts`
- `apps/mobile/src/api/analytics.ts`
- `apps/mobile/src/analytics/format.ts`
- `apps/mobile/src/analytics/__tests__/format.test.ts`
- `apps/mobile/src/api/__tests__/analytics.test.ts`
- `apps/mobile/src/api/__tests__/live/analytics.live.test.ts`
- `apps/mobile/src/screens/ArtistAnalyticsScreen.tsx`
- `apps/mobile/src/screens/__tests__/ArtistAnalyticsScreen.test.tsx`
- `apps/mobile/src/app/(artist)/analytics.tsx`
- `docs/adr/011-artist-analytics-event-aggregation.md`
- `docs/PHASE-15-REPORT.md`

Modified:

- `services/api/prisma/schema.prisma` (two `@@index` entries)
- `services/api/src/http/app.ts` (analytics module registration)
- `apps/mobile/src/api/types.ts` (analytics DTOs)
- `apps/mobile/src/api/index.ts` (analytics re-exports)
- `apps/mobile/src/app/(artist)/_layout.tsx` (analytics route)
- `apps/mobile/src/screens/ArtistDashboardScreen.tsx` ("View analytics" action)

One bug fixed during verification: the screen's mount sequence did a
full analytics fetch with `artistId=null` (reaching `ready`) and then
refetched on artist resolution, causing a ready → loading → ready
flicker and flaky component tests. The bootstrap pass now resolves the
artist without fetching analytics; the single real fetch happens on the
refire.
