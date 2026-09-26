# Synchronized Listening Rooms (Phase 28)

How social listening works in this codebase: the sync model, the API
surface, the mobile pipeline, and what must still be proven on real
devices. For the decision record, see
`docs/adr/022-synchronized-listening-rooms.md`.

## The sync model in one paragraph

A room is **server-authoritative state plus a dumb fan-out**. The host's
transport commands (play/pause/seek/next/previous/queue) advance a
monotonic `revision` through an atomic database compare-and-swap; every
subscriber receives the new state over WebSocket and applies it to the
one shared `PlaybackEngine`. `positionMs` is authoritative at the
server's `stateAt` timestamp — clients extrapolate from there using a
median-of-8 NTP-style clock-offset estimator, never trusting the local
clock. Rooms never grant entitlement: every listener mints their own
ordinary Phase 7 playback session, so play events, streams,
listening-time, and royalties keep their exact per-user semantics.

## Backend

Module: `services/api/src/modules/rooms/` (`service.ts`, `routes.ts`,
`gateway.ts`, `hub.ts`, `schemas.ts`). Migration
`20260925233551_phase28_rooms` (4 enums, 4 tables, 7 indexes, 9 FKs).

| Endpoint / socket                                  | Purpose                                              |
| -------------------------------------------------- | ---------------------------------------------------- |
| `POST /v1/rooms`                                   | Create a room (queue from `trackIds` or a playlist the caller can access) |
| `GET /v1/rooms/:id`                                | Authoritative state (members only)                   |
| `POST /v1/rooms/:id/join`                          | Join with a single-use invitation token              |
| `POST /v1/rooms/:id/leave`                         | Leave; host leaving ends the room                    |
| `POST /v1/rooms/:id/end`                           | Host ends the room                                   |
| `GET /v1/rooms/:id/members`                        | Member list (members only)                           |
| `POST /v1/rooms/:id/invitations`                   | Host mints a single-use invitation (raw token once)  |
| `GET /v1/rooms/:id/invitations`                    | Host lists invitations (hashes never exposed)        |
| `DELETE /v1/rooms/:id/invitations/:invitationId`    | Host revokes an invitation                           |
| `GET /v1/rooms/ws?token=<access JWT>`              | WebSocket: state sync + host commands                |

Rules that matter:

- Rooms are private and invite-only (`RoomVisibility` = `PRIVATE` only).
  There is no discovery or listing endpoint; non-members get
  existence-hiding 404s everywhere.
- Creating or joining requires playback entitlement and never grants any.
  Membership rows never substitute for a subscription check.
- Queue tracks must exist, be undeleted, and have `READY` processing
  status; queue capped at 200 tracks.
- Invitation tokens are 32 random bytes (base64url), SHA-256 hashed at
  rest, single-use via transactional conditional claim, 7-day TTL,
  host-revocable. Expired/revoked/used/unknown tokens are
  indistinguishable (404).
- Host commands require `expectedRevision`; stale commands get
  `stale_revision` + the authoritative state and never land.
- When the host leaves, the room ends for everyone — ownership is never
  transferred. Memberships survive END so members can fetch the terminal
  state after a reconnect. WebSocket disconnect never leaves/ends a room.
- `member_joined` fires only on a genuinely new HTTP membership;
  `member_left`/`room_ended` broadcast before socket eviction so every
  subscriber learns the outcome, then unauthorized subscriptions are
  dropped immediately.
- Room state/events carry track IDs and display metadata only — never
  playback tokens, audio URLs, or invitation secrets. The WS `token`
  query parameter is stripped from the request URL before logging.
- Rate limits: create 10/window, join 30/window, invite issuance
  20/window, WS host commands 30 per 10s per socket, 64 KiB inbound
  payload cap.
- Known limitation: the socket hub is in-process. Multi-instance
  deployments need a shared pub/sub (e.g. Redis) for cross-instance
  fan-out; the DB revision CAS stays authoritative regardless.

### WebSocket protocol

Client → server: `ping`, `room.join`, `room.leave`, `room.resync`,
`room.command` (`play`/`pause`/`seek`/`next`/`previous`/`queue` with
`expectedRevision`).

Server → client: `pong` (`clientTime` + `serverTime`), `room.state`
(full `RoomStateDto`), `room.event`
(`member_joined`/`member_left`/`room_ended`), structured `error`
(`room_not_found`, `host_only`, `stale_revision`, `room_ended`,
`entitlement_required`, `rate_limited`, `invalid_command`).

## Mobile

Modules: `apps/mobile/src/rooms/` (`transport.ts`, `controller.ts`,
`RoomProvider.tsx`, `invite.ts`), `apps/mobile/src/api/rooms.ts`,
screens in `apps/mobile/src/app/room/`.

- **`RoomTransport`** — typed WS client with injectable socket factory,
  median-of-8 clock sync, ping on open then every 10s, reconnect backoff
  (1s/2s/5s/10s/30s, stops on 4401), malformed-message tolerance.
- **`RoomSession`** — drives the existing shared `PlaybackEngine`
  (no second player): host create + token join, server-authoritative
  state with stale/duplicate revision rejection, position extrapolation
  from `serverTime`, drift correction (1.5s immediate / 3s periodic
  thresholds, 2s tick), feedback-loop suppression, host-only outbound
  commands, natural host completion (genuine engine `COMPLETE` →
  room `next`; room `pause` at natural queue end — no synthesized play
  events), repeat mode saved/forced-off/restored, 60s reconnect give-up,
  NetInfo-driven immediate leave on confirmed connectivity loss.
- **`PlaybackEngine.setForceOnline`** — additive seam: room playback
  always resolves online sources and mints ordinary Phase 7 sessions;
  personal offline-first behavior (Phase 25) is unchanged outside rooms.
- **UI** — room lobby (start from current queue / join by ID + token),
  active room screen (connection banners, current track + progress, host
  controls, read-only participant view, members, queue, invite sharing,
  leave/end). Full player shows a room banner with participant transport
  disabled; mini player shows a "Room" badge (host toggle routes to the
  room; participant keeps a local pause/resume escape hatch). Profile has
  a listening-room entry.
- **Cars** — CarPlay and Android Auto get no room-management surfaces and
  keep using the shared engine.

## What still needs real devices

No Android SDK, physical device, CarPlay head unit, or Android Auto head
unit exists in the sandbox. Unverified until real hardware: physical
sync tightness (drift thresholds are estimates), background transitions,
interrupted connectivity, lock-screen controls, and actual
projected-car behavior.
