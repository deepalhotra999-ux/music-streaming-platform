# Phase 28 Report — Synchronized Listening Rooms (Social Listening)

**Date:** 2026-09-26
**Baseline:** `7b7e96d` (Phase 27: Collaborative Playlists)
**Status:** Complete, verified, documented, cleaned up. Ready to commit.
Stopped at the phase boundary — **Phase 29 was not started.**

## What was built

**Backend** (`services/api/src/modules/rooms/`):

- Room schema: `listening_rooms` (revision CAS, host FK, visibility PRIVATE),
  `listening_room_queue_items` (ordered, cap 200, READY-only tracks),
  `listening_room_members` (composite PK, HOST|PARTICIPANT), and
  `listening_room_invitations` (SHA-256 token hashes, single-use, 7-day TTL).
  Migration `20260925233551_phase28_rooms` is a clean Phase-28-only migration
  (4 enums, 4 tables, 7 indexes, 9 FKs) — shadow-DB comparison noise was
  removed, and both databases were dropped and re-migrated from scratch to
  prove a fresh deploy.
- HTTP routes: create, state, join (single-use token claim), leave,
  end, members, invitation CRUD. No discovery/listing endpoint;
  existence-hiding 404s for non-members.
- WebSocket gateway at `GET /v1/rooms/ws?token=<access JWT>`: client
  `ping`, `room.join/leave/resync/command`; server `pong`, `room.state`,
  `room.event`, structured errors. Server-authoritative revision CAS on
  every host command; host-only authorization; 64 KiB inbound cap; host
  command throttle (30/10s/socket); token stripped from URLs before logging.
- Security semantics: entitlement required to create/join but never
  granted; membership is not entitlement. Private rooms never appear in
  search/recommendations/playlists/profiles/AI discovery. No playback
  tokens, audio URLs, or invitation secrets in events/logs. Host leave/end
  terminates the room for everyone (no silent ownership transfer);
  membership survives END for terminal-state retrieval. `member_joined`
  fires only on genuinely new membership; `member_left`/`room_ended`
  broadcast before socket eviction.
- Known limitation: the socket hub is in-process; multi-instance
  deployments need a shared pub/sub for cross-instance fan-out (the DB
  revision CAS stays authoritative regardless).

**Mobile** (`apps/mobile/`):

- `src/rooms/`: typed `RoomTransport` (WS client, median-of-8 clock sync,
  1/2/5/10/30s reconnect backoff, malformed-message tolerance) and
  `RoomSession` sync controller (server-authoritative state, position
  extrapolation from `serverTime`, drift correction at 1.5s immediate /
  3s periodic, host-only commands, natural host completion, repeat
  save/force-off/restore, 60s give-up, NetInfo-driven leave on confirmed
  connectivity loss) under a `RoomProvider`.
- Single shared `PlaybackEngine` — never a second player. An additive
  `setForceOnline()` seam makes room playback always resolve online
  sources and mint ordinary Phase 7 playback sessions, so every
  listener keeps individual play events/streams/listening-time/royalty
  semantics. Personal offline-first behavior (Phase 25) is unchanged
  outside rooms.
- UI: room lobby (start from current queue / join by ID + token), active
  room screen (connection banners, host controls, read-only participant
  view, members, queue, invite sharing, leave/end), room banner in the
  full player, "Room" badge in the mini player, profile entry. CarPlay
  and Android Auto get no room-management surfaces and keep using the
  shared engine.

**Docs:** `docs/adr/022-synchronized-listening-rooms.md`,
`docs/SOCIAL-LISTENING.md`, `docs/PHASE-28-REPORT.md` (this file).

## Acceptance criteria

- [x] Host creates a private room; participants join via single-use
      invitation tokens; no discovery/list endpoint.
- [x] Host transport (play/pause/seek/next/previous/queue) drives all
      listeners with server-authoritative revision CAS; stale commands
      never land.
- [x] Clock-skew-robust sync (median-of-8 offset, server-time
      extrapolation, drift correction) with no second player.
- [x] Every listener keeps individual Phase 7/15/21 playback semantics;
      room grants no entitlement; offline-first unchanged outside rooms.
- [x] Invitation tokens hash-only, single-use, expiring, revocable;
      no secrets/tokens/audio URLs in events or logs.
- [x] Host leave/end terminates for all; no ownership transfer; terminal
      state retrievable; disconnect never leaves/ends.
- [x] No chat, messaging, communities, commerce, WebRTC, voting, or car
      room-management surfaces. CarPlay/Android Auto use the shared engine.
- [x] Phase 29 was not started.

## Tests

- Backend Phase 28 suite: **41/41** (`services/api/tests/phase28.test.ts`):
  revision CAS, stale-command rejection, host-only authorization,
  invitation single-use/expiry/revocation/indistinguishable-404s,
  entitlement gating, member_joined/left semantics, socket eviction on
  leave/end, queue cap/streamability, secret-hygiene (no tokens/URLs in
  events/logs), rate limiting.
- Backend full suite: **518/519** — the one failure is the known
  pre-existing analytics UTC-day test (`analytics.test.ts > trend >
  buckets plays by UTC day`), left untouched per protocol.
- Backend TypeScript (`tsc --noEmit`): clean. Backend build: clean.
- Backend ESLint on room sources: clean; `phase28.test.ts` has 7
  pre-existing `@typescript-eslint/no-explicit-any` errors in the WS
  collector helper (verified pre-existing via stash comparison).
- Mobile full suite: **708/708 across 92 suites**, including 26
  controller/transport/provider tests, 15 room API client tests, room
  force-online engine tests, and host/participant FullPlayer tests.
- Mobile TypeScript: clean. Mobile ESLint: clean (4 unused-variable
  issues fixed during the phase). Prettier: applied to all Phase 28 files.
- Admin suite: **36/36**, 8 files. Admin TypeScript: clean. Admin build:
  clean.
- Expo Doctor: **19/21** — the 2 failures (direct `expo-modules-core`
  dependency warning; dependency-validation of 5 out-of-date Expo
  packages) are pre-existing and identical on the Phase 27 baseline
  (verified via stash comparison).
- Android export: clean. iOS export: clean.
- Secret scan across Phase 28 files: no matches. Token/URL leak scan:
  clean (broadcasts and logs carry IDs and display metadata only).
- Migration: proven by dropping both databases and deploying all
  migrations from scratch — success on `musicdb` and `musicdb_test`;
  Prisma client regenerated; room tables present.

## Manual checklist

- [ ] Real device: room create/join flow, sync tightness, drift
      correction behavior, background transitions, interrupted
      connectivity, lock-screen controls, invite sharing.
- [ ] CarPlay head unit / Android Auto head unit: confirm no
      room-management surfaces appear and the shared engine follows
      room playback normally.
- [ ] Accessibility pass with screen reader on device.
- [ ] No production-readiness claim until the above are evidenced.

## Honest limitations

- In-process socket hub: multi-instance deployments need shared pub/sub
  for live cross-instance fan-out (correctness is DB-authoritative either way).
- Drift thresholds (1.5s immediate / 3s periodic) are estimates; physical
  sync tightness unverified.
- Invitation delivery is out of band (no email/push); the host shares
  the token. Queue cap 200; host cannot be transferred.

## Files created

- `services/api/src/modules/rooms/` (service, schemas, routes, hub, gateway)
- `services/api/tests/phase28.test.ts`
- `services/api/prisma/migrations/20260925233551_phase28_rooms/migration.sql`
- `apps/mobile/src/api/rooms.ts`
- `apps/mobile/src/api/__tests__/rooms.test.ts`
- `apps/mobile/src/rooms/` (transport, controller, RoomProvider, invite, index + 3 test files)
- `apps/mobile/src/app/room/` (index, join, [id], _layout)
- `apps/mobile/src/playback/__tests__/PlaybackEngineForceOnline.test.ts`
- `apps/mobile/src/player/__tests__/RoomIntegration.test.tsx`
- `docs/adr/022-synchronized-listening-rooms.md`
- `docs/SOCIAL-LISTENING.md`
- `docs/PHASE-28-REPORT.md`

## Files modified

- `services/api/prisma/schema.prisma`, `services/api/package.json`,
  `package-lock.json` (@fastify/websocket, @types/ws), `services/api/src/config.ts`,
  `src/http/app.ts`, `src/http/errors.ts`, `src/http/limits.ts`
- `apps/mobile/package-lock.json`
- `apps/mobile/src/api/index.ts`
- `apps/mobile/src/app/_layout.tsx` (RoomProvider mount)
- `apps/mobile/src/playback/PlaybackEngine.ts` (additive `setForceOnline`)
- `apps/mobile/src/player/FullPlayer.tsx`, `MiniPlayer.tsx`,
  `PlayerControls.tsx`, `QueueView.tsx`, `__tests__/FullPlayer.test.tsx`,
  `__tests__/MiniPlayerHost.test.tsx`
- `apps/mobile/src/screens/ProfileScreen.tsx`

## Physical-test gaps

No Android SDK, physical mobile device, CarPlay head unit, or Android
Auto head unit exists in the sandbox. Real-device sync timing,
background transitions, interrupted connectivity, lock-screen controls,
projected-car behavior, and accessibility are unproven on hardware.
