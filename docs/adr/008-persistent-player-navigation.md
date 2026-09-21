# ADR-008: Persistent player navigation architecture

Date: 2026-09-21
Phase: 9 — Player UI
Supersedes: nothing (builds on ADR-007, which defined the playback engine)

## Context

Phase 9 adds the user-facing player UI around the Phase 8 `PlaybackEngine`:
a mini player that must persist across Home, Search, Library, and catalog
navigation, and a full-screen player. The engine is framework-independent
and bound to React via `PlaybackProvider`, which mounts only while
authenticated (sign-out stops playback). The UI must subscribe to this
single engine — no second audio system, no duplicated state.

## Decision

**Two thin UI layers over the one engine, with the mini player as a
root-level overlay and the full player as a real modal route.**

- `apps/mobile/src/player/` holds pure view components (state/callback
  props; no engine imports) plus hooked wrappers (`MiniPlayer`,
  `FullPlayer`) that subscribe via `usePlayback`. All queue construction
  goes through `useQueueActions()`, which maps API `TrackSummary` records
  to engine `QueueTrack` records in one place.
- `MiniPlayerHost` mounts once inside the authenticated `PlaybackShell` in
  `app/_layout.tsx`, *above* the root stack navigator. It is therefore
  never unmounted by tab switches or catalog pushes — persistence without
  touching the tab navigator or re-mounting on every route. Visibility is
  a pure function of the engine snapshot (`track !== null && state !==
  'idle'`) plus the route segments: it hides on `/player` (the host
  overlays the navigator, so without this the bar would sit on top of the
  full player on surfaces where the modal presentation does not cover the
  window, e.g. web) and offsets above the tab bar on `(tabs)` routes.
- The full player is a real route, `app/player.tsx`, registered as
  `<Stack.Screen name="player" options={{ presentation: 'modal' }} />` in
  the authenticated guard. Expand is `router.push('/player')`; minimize is
  `router.back()` with a `router.replace('/(tabs)')` fallback when there is
  no history. A route (not a conditional component) keeps it deep-linkable
  and gives correct back-button behavior.
- The seek bar uses direct touch handlers (`onTouchStart/Move/End/Cancel`),
  not `PanResponder`: PanResponder's adapted responder props cannot be
  invoked in the test renderer, which would have left the seek-commit path
  untestable. The position math is a pure, unit-tested function.

## Consequences

- The engine remains the sole source of playback truth; the UI cannot
  diverge from it because it holds no playback state.
- `stop()` keeps the queue by design (Phase 8 contract): closing the mini
  player hides the bar (track becomes null) while the queue survives for
  resume from the full player.
- The tab-bar offset is a constant (56 pt) plus the safe-area inset; it is
  an approximation until verified on device.
- Future surfaces (background service, lock screen, CarPlay, Android Auto)
  reuse the same engine snapshots; the player module needs no changes to
  feed them.
