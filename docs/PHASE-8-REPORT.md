# Phase 8 Report — Mobile Playback Engine

Date: 2026-09-21
Commit: (this phase)
ADR: `docs/adr/007-mobile-playback-engine.md`

## What was built

A native-capable, foreground-only HLS playback engine for the Expo mobile
app that plays Phase 7 playback sessions. No player UI (out of scope); the
engine is framework-independent and bound to React through a provider.

### Acceptance criteria

| Criterion | Result |
|---|---|
| Play Phase 7 HLS streams via a native-capable Expo/RN architecture | ✅ `expo-audio` 57.0.5 adapter; one native player at a time |
| Play/pause, seek, position, duration, status, loading/buffering, errors | ✅ Engine + snapshot (`idle/loading/playing/paused/buffering/ended/error`) |
| Local queue with next/previous | ✅ `setQueue/enqueue/clearQueue/next/previous`; previous restarts past 3 s |
| Send START, HEARTBEAT, COMPLETE, ERROR | ✅ Against the real API (live test); fire-and-forget |
| Correctly release/replace sessions when changing tracks | ✅ Teardown-before-replacement; stale loads invalidated by generation counter |
| Handle network interruption gracefully | ✅ Driver error → `error` state → `retry()` mints a fresh session, resumes at last position |
| Prevent simultaneous audio instances | ✅ Adapter destroys the previous player before creating another; asserted `maxConcurrentPlayers <= 1` |
| Use existing synthesized dev HLS audio only | ✅ No new audio; live test plays the generated tracks |
| Seams for background/lock-screen/CarPlay/Auto/offline | ✅ `AudioDriver` interface + engine lifecycle hooks; nothing implemented |
| Dev build/prebuild if required by native modules | ✅ `expo-audio` + `expo-asset`; prebuild validated |

## Tests

### Automated

- **Mobile unit: 123/123 pass (15 suites)**, including 26 new
  `PlaybackEngine` tests with a fake driver + fake API transport (a real
  `ApiClient` over a stubbed fetch). They pin: session-per-track with
  relative-URL resolution, START-once, position/duration/buffering mirroring,
  pause/toggle/seek (clamped), seek-during-loading, teardown-before-replace
  ordering (journal: `destroy → session → load`), no COMPLETE on manual
  skip, previous restart/back/head semantics, COMPLETE + auto-advance + end
  of queue, HEARTBEAT cadence with fake timers (pause stops it, resume
  restarts it exactly once), telemetry-failure isolation, ERROR with last
  position, retry with fresh session + resume seek, play-from-error,
  load-failure ERROR, session-creation failure without an API ERROR event,
  stop-wins-the-race, superseded-load race, single-player invariant.
- **Mobile live: engine test passes** against the real API — registers a
  user, finds a READY track, `setQueue` creates a real session, the exact
  URI the engine hands the player serves `#EXTM3U`, START + COMPLETE are
  accepted (zero engine errors).
- **Backend: 100/100 pass** (unchanged; no backend changes this phase).
- `tsc --noEmit` clean, `expo lint` clean, **Expo Doctor 21/21**
  (installed the missing `expo-asset` peer dependency it flagged).
- `expo prebuild` succeeds; native projects confirm foreground-only (no
  iOS background modes; Android has no media services, no
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, no `RECORD_AUDIO`).
- `expo export` succeeds for android and ios.

### Manual checklist

- [x] Fresh session per track; token only inside the session-scoped HLS URL
- [x] Driver teardown precedes replacement (destroy logged before new session)
- [x] Stale async loads discarded after stop/supersede
- [x] Pending seek survives session minting
- [x] Network error → retry with fresh session at last position
- [x] Telemetry failure cannot stop playback
- [x] Sign-out unmounts the provider and stops playback
- [ ] Real on-device HLS audio — **not physically tested** (see below)

### Not physically tested

No Android SDK, Java, or device/emulator exists in this sandbox, so the
Android development build was not compiled and real HLS audio was not heard
on a device. The native layer is validated up to prebuild + export; the
engine's contract with it is covered by unit tests, and the API contract by
the live test. The `expoAudioDriver` adapter itself (thin `expo-audio`
calls) has no automated test — mocking `expo-audio` would test the mock.

## Key decisions (see ADR-007)

- Framework-independent `PlaybackEngine` + single `AudioDriver`; React
  binds via `useSyncExternalStore`.
- Exactly one native player: the adapter destroys the previous player
  before `createAudioPlayer()`.
- Foreground-only this phase: plugin `enableBackgroundPlayback: false`,
  `recordAudioAndroid: false`; audio mode `shouldPlayInBackground: false`,
  `interruptionMode: 'doNotMix'`, `playsInSilentMode: true`.
- Manual skip never emits COMPLETE; only natural `didJustFinish` does.
- `loadGeneration` invalidates stale session/driver continuations.
- Heartbeat timer runs only while playing (`ensureHeartbeat` guard).
- Provider mounts only when authenticated; unmount calls `stop()` (safe
  under StrictMode remounts).

## Files created

- `apps/mobile/src/playback/PlaybackEngine.ts` — framework-free engine
- `apps/mobile/src/playback/expoAudioDriver.ts` — sole `expo-audio` adapter
- `apps/mobile/src/playback/provider.tsx` — React binding, auth-gated mount
- `apps/mobile/src/playback/types.ts` — `QueueTrack`, `AudioDriver`, snapshot, `toQueueTrack`
- `apps/mobile/src/playback/index.ts` — public exports
- `apps/mobile/src/playback/__tests__/fakeDriver.ts` — shared fake driver
- `apps/mobile/src/playback/__tests__/PlaybackEngine.test.ts` — 26 unit tests
- `apps/mobile/src/playback/__tests__/live/engine.live.test.ts` — live contract test
- `docs/adr/007-mobile-playback-engine.md`

## Files modified

- `apps/mobile/package.json` / `package-lock.json` — `expo-audio`, `expo-asset` (SDK 57)
- `apps/mobile/app.json` — `expo-audio` plugin, foreground-only flags
- `apps/mobile/src/app/_layout.tsx` — mount `PlaybackProvider` when authenticated

## Notes

- `android/`, `ios/`, `dist/` were generated for prebuild/export validation
  and removed; they are gitignored and not committed.
- No backend changes. No player UI. Phase 9 not started.
