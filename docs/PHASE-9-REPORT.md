# Phase 9 Report — Player UI

Date: 2026-09-21
Commit: (this phase)
ADR: `docs/adr/008-persistent-player-navigation.md`

## What was built

The user-facing player UI around the existing Phase 8 `PlaybackEngine` —
no second audio system. A persistent mini player overlays the authenticated
app (surviving Home/Search/Library/catalog navigation), expands to a
full-screen modal player, and the whole catalog is wired for tap-to-play
with contextual queues. Engine extensions (shuffle, repeat, queue
edit/jump) were additive only; the backend was not touched.

### Acceptance criteria

| Criterion | Result |
|---|---|
| Persistent mini player across Home, Search, Library, catalog navigation | ✅ `MiniPlayerHost` mounted once in the authenticated root shell, above the navigator; survives tab switches and catalog pushes |
| Full-screen player | ✅ `/player` modal route; artwork, title, artist, seek bar with times, transport + shuffle/repeat, queue, minimize |
| Artwork, title, artist | ✅ `ArtworkImage` from the Phase 6 catalog kit in both surfaces |
| Play/pause, seek, elapsed/duration, previous/next | ✅ Engine-driven; custom dependency-free `SeekBar` (tap/drag/scrub preview, a11y increment/decrement) |
| Queue, shuffle, repeat | ✅ Engine extended: `RepeatMode` (`off/all/one`), `shuffle`, `removeAt`, `playAt`, `setRepeatMode`, `setShuffle`; full-player queue list with jump + remove |
| Loading/buffering/error/retry states | ✅ Buffering spinners, loading overlays, error banners with retry (fresh session), per-surface |
| Add/remove from queue | ✅ Long-press any track row appends to queue; queue rows remove (without triggering play) |
| Close/minimize | ✅ Mini-player ✕ stops (queue kept, bar hides); full-player minimize `router.back()` with `/(tabs)` fallback |
| UI subscribes to the existing engine | ✅ Views are pure (state/callback props); hooked wrappers use `usePlayback` only |
| Phase 5 design system | ✅ Theme colors/spacing/typography, `Button`, `EmptyState`, `LoadingIndicator` reused; no new styling language |
| Backend untouched | ✅ Zero backend changes; all API calls go through the existing Phase 7 contracts |

## Tests

### Automated

- **Mobile unit: 191/191 pass (22 suites)**, including:
  - 15 new engine tests (repeat-one/all wrap + edge next/previous, previous-restart preserved, shuffle upcoming-only + order stability, removeAt current/earlier/upcoming/final, playAt teardown path, `canNext/canPrevious` under repeat-all).
  - 46 player component/state tests: seek math + touch commit + disabled + a11y, transport/mode labels + callbacks, queue jump/remove/current marker, mini-player metadata/expand/toggle/close/loading/error, visibility rules (incl. hidden on `/player`, tab-bar offset), full-player metadata/times/loading/error/retry/seek/queue/minimize, queue construction + enqueue delegation, Home tap/long-press, row long-press.
- **Mobile live: 12/12 pass (4 suites)** — the new `phase9-queue.live.test.ts`
  drives the engine through the exact UI call sequence against the real
  API with dev audio: real session per track, the exact HLS URI serves
  `#EXTM3U`, **ffprobe confirms playable AAC**, setQueue/toggle/seek/
  next/previous/playAt/removeAt/enqueue/shuffle/repeat-all wrap/
  repeat-one replay/repeat-off end/stop, zero engine errors,
  `maxConcurrentPlayers <= 1`. Existing live suites (auth, catalog,
  Phase 8 engine) still pass.
- **Backend: 100/100 pass** (unchanged; no backend changes this phase).
- `tsc --noEmit` clean, `eslint` clean, **Expo Doctor 21/21**, `expo export`
  succeeds for android and ios.
- Router usage verified against versioned Expo Router docs: modal pattern
  (`Stack.Screen` + `presentation: "modal"` + `router.push`), `useSegments()`
  shape for the `/player` hide rule and the tab-bar offset.

### Manual checklist

- [x] Mini player persists while navigating tabs and catalog stacks (single host above the root stack; no remount)
- [x] Mini player hides on the full-player route (segments check; fixes the web overlay case)
- [x] Mini-player position clears the tab bar (tab-bar offset + safe-area inset; exact pixels unverified on device)
- [x] Tap-to-play builds contextual queues (home recents, artist top tracks, album, playlist, track list); tap index starts at the tapped track
- [x] Long-press appends to queue; row remove does not trigger play (`stopPropagation` in `QueueRow`)
- [x] Repeat/shuffle/queue edits behave per the engine contract (unit + live)
- [x] Close stops playback and hides the bar; the queue is intentionally kept for resume
- [x] Error → retry mints a fresh session and resumes
- [x] Sign-out still unmounts the provider and stops playback (Phase 8 behavior preserved)
- [ ] Real on-device playback, taps, and animations — **not physically tested** (see below)

### Not physically tested

No Android SDK, Java, or device/emulator exists in this sandbox, so no
development build was compiled and no real HLS audio was heard on a
device. Specifically unverified on hardware: the mini→full→mini tap flow,
playback continuing visibly across tab/catalog navigation, the iOS/Android
modal presentation animation, the 56 pt tab-bar offset pixel alignment,
and touch feel of the seek bar. The engine contract with the native layer
is covered by unit tests and the API/HLS contract by the live test
(including ffprobe-proven playable audio at the exact URI the engine
hands the player).

## Key decisions (see ADR-008)

- **One engine, two thin UI layers.** `src/player/` holds pure view
  components (props in, callbacks out) plus hooked wrappers that subscribe
  to `usePlayback`. No state lives in the UI; the engine remains the sole
  source of truth.
- **Mini player as a root-level overlay, not a screen.** `MiniPlayerHost`
  mounts inside the authenticated `PlaybackShell`, above the root stack —
  persistence without re-mounts, without touching the tab navigator.
- **Full player as a real route** (`/player`, `presentation: "modal"`),
  not a conditional component — deep-linkable, back-button friendly,
  minimize via `router.back()`.
- **No PanResponder.** The seek bar uses direct touch handlers; PanResponder's
  adapted responder props cannot be invoked in tests, so the commit path
  would have been untestable. Touch math is pure and unit-tested.
- **Global `expo-audio` mock in jest.setup.js**, alongside the existing
  native-module mocks — component tests import through the playback barrel.
- **stop() keeps the queue by design** (Phase 8 contract): close hides the
  mini player (track becomes null) while the queue survives for resume in
  the full player.

## Files created

- `apps/mobile/src/player/` — `constants.ts`, `SeekBar.tsx`,
  `PlayerControls.tsx`, `QueueView.tsx`, `MiniPlayer.tsx`,
  `MiniPlayerHost.tsx`, `FullPlayer.tsx`, `useQueueActions.ts`, `index.ts`
- `apps/mobile/src/player/__tests__/` — `SeekBar.test.tsx`,
  `PlayerControls.test.tsx`, `QueueView.test.tsx`, `MiniPlayer.test.tsx`,
  `MiniPlayerHost.test.tsx`, `FullPlayer.test.tsx`, `useQueueActions.test.tsx`
- `apps/mobile/src/app/player.tsx` — full-player route shim
- `apps/mobile/src/playback/__tests__/live/phase9-queue.live.test.ts` — live
  end-to-end of the Phase 9 surface against the real API
- `docs/adr/008-persistent-player-navigation.md`

## Files modified

- `apps/mobile/src/playback/types.ts` — `RepeatMode`, `repeatMode`/`shuffle`
  snapshot fields, `albumId` on `QueueTrack`
- `apps/mobile/src/playback/PlaybackEngine.ts` — `removeAt`, `playAt`,
  `setRepeatMode`, `setShuffle` (additive; transport/session/telemetry
  paths untouched)
- `apps/mobile/src/playback/provider.tsx`, `index.ts` — expose the new
  engine API through context
- `apps/mobile/src/playback/__tests__/PlaybackEngine.test.ts` — 15 new tests
- `apps/mobile/src/app/_layout.tsx` — `MiniPlayerHost` in the auth shell;
  `/player` modal route
- `apps/mobile/src/catalog/components/Rows.tsx` — `onLongPress` on
  `TrackRow`/`AlbumTrackRow`
- `apps/mobile/src/screens/` — `HomeScreen`, `TrackListScreen`,
  `ArtistDetailScreen`, `AlbumDetailScreen`, `PlaylistDetailScreen`:
  tap-to-play with contextual queues + long-press to queue
- `apps/mobile/src/screens/__tests__/HomeScreen.test.tsx`,
  `apps/mobile/src/catalog/components/__tests__/Rows.test.tsx` — new coverage
- `apps/mobile/jest.setup.js` — `expo-audio` mock; mutable router segments

## Notes

- The general track list (`TrackListScreen`) starts a one-track queue on
  tap because its list abstraction does not expose the loaded page to rows;
  artist/album/playlist/home build full contextual queues.
- Long-press to queue is undiscoverable without a hint — accepted for this
  phase; a visible affordance belongs to a later UX pass.
- Live-test user and play events were deleted; the API dev server was
  stopped. No backend migrations, no seed changes.
