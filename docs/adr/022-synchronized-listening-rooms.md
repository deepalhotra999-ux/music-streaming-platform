# ADR-022: Synchronized Listening Rooms — Server-Authoritative State, Entitlement Isolation & Private Membership

**Date:** 2026-09-25
**Status:** Accepted
**Phase:** 28

## Context

Phase 28 adds synchronized social listening: a host creates a private,
invite-only listening room, participants join with a single-use invitation
token, and everyone hears the same queue in sync — the host's transport
(play/pause/seek/next/previous/queue) drives every listener. The core
tensions:

1. **Synchronization without a second player.** The mobile app already has
   one shared `PlaybackEngine` (Phases 8–10) with background audio, remote
   commands, offline-first resolution, and CarPlay/Android Auto projection.
   Rooms must reuse that engine — never a parallel player, never duplicated
   session/royalty logic.
2. **Entitlement isolation.** Joining a room must never grant playback
   entitlement. Every listener keeps their own Phase 7 playback session,
   play events, streams, listening-time, and royalty semantics. A room is a
   synchronization layer, not a license.
3. **Privacy.** Rooms are private and invite-only. There is no discovery,
   no listing endpoint, and non-members get existence-hiding 404s
   (Phase 4/27 convention). Private rooms must never surface in search,
   recommendations, playlists, profiles, or AI discovery.
4. **Clock reality.** Listeners' devices have skewed clocks and variable
   network latency. Position synchronization must be robust to both without
   trusting any client timestamp as authoritative.
5. **Secret hygiene.** Invitation tokens, playback tokens, and audio URLs
   must never appear in room events, logs, or state payloads.

## Decision summary

1. **Server-authoritative state with a monotonic revision.** Every host
   command advances `listening_rooms.revision` through an atomic
   compare-and-swap (`updateMany` with a `revision = expectedRevision`
   predicate inside the transaction). Stale commands get a 409-style
   `stale_revision` error plus the authoritative state, and never land.
   The in-process WebSocket hub is fan-out only; the database is the
   source of truth, so the revision protocol is instance-independent.
2. **`positionMs` is authoritative at `serverTime`.** The server stamps
   every state with its own clock (`stateAt`). Clients extrapolate
   `expected = positionMs + (now - stateAt)` while PLAYING, using a
   median-of-8 NTP-style offset estimator fed by WebSocket ping/pong.
   Client clocks are never trusted.
3. **Every listener mints an ordinary Phase 7 playback session.**
   The room controller drives the existing shared `PlaybackEngine`; a
   minimal additive `forceOnline` seam makes room playback always resolve
   online sources (Phase 25 offline-first behavior is untouched outside
   rooms). Natural track completion on the host emits the genuine engine
   `COMPLETE` event and the controller issues a room-level `next` — no
   synthesized play events, no royalty bypass.
4. **Private by construction.** `RoomVisibility` has a single value,
   `PRIVATE`. There is no list/search endpoint; membership and host
   identity come from the auth session. Invitation tokens are 32 random
   bytes (base64url), SHA-256 hashed at rest, single-use (transactional
   conditional claim), 7-day TTL, host-revocable, and returned in plaintext
   exactly once. Expired/revoked/used/unknown tokens are
   indistinguishable (404) so tokens cannot be probed.
5. **Deterministic host-leaving policy.** When the host leaves, the room
   ends immediately for everyone — ownership is never silently
   transferred. Membership rows survive END so members can fetch the
   terminal ENDED state after a reconnect. WebSocket disconnect never
   leaves or ends a room.
6. **Membership events, not socket events.** `member_joined` fires only on
   a genuinely new HTTP membership (never on idempotent rejoin, never on
   WS resubscribe). `member_left`/`room_ended` broadcast before socket
   eviction, so every subscriber learns the outcome; eviction then drops
   subscriptions that are no longer authorized.
7. **No room-management surfaces in cars.** CarPlay and Android Auto keep
   using the shared engine with zero room UI; they follow whatever the
   phone's engine is doing.

## Consequences

- Multi-instance deployments need a shared pub/sub (e.g. Redis) for
  cross-instance broadcast fan-out. Correctness does not depend on it —
  the DB revision CAS is authoritative — but live updates would lag
  without it. Documented as a known limitation.
- Room playback requires connectivity (`forceOnline`); offline-first
  personal playback is unchanged outside rooms.
- Drift correction (1.5s immediate / 3s periodic thresholds) is a
  deliberate trade-off: tight enough to feel synchronized, loose enough
  to avoid seek thrash on jittery networks. Physical-device tuning is
  still unverified (no device/head unit in the sandbox).

## Alternatives considered

- **Client-driven sync (host broadcasts position):** rejected — trusts
  client clocks, no authority to resolve conflicts, trivially spoofable.
- **CRDT/OT for queue edits:** rejected — only the host mutates the
  queue, so a single-writer CAS is simpler and strictly serializable.
- **Transferring host ownership on leave:** rejected — silent ownership
  transfer is surprising and creates entitlement-adjacent ambiguity;
  explicit end is predictable.
