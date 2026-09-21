# ADR-007: Mobile playback engine (foreground HLS)

Date: 2026-09-21
Phase: 8 — Mobile Playback Engine
Supersedes: nothing (builds on ADR-006, which defined the streaming backend)

## Context

Phase 7 shipped streaming infrastructure: opaque short-lived playback
sessions, session-scoped HLS delivery, and an append-only play-events log.
Phase 8 must play those HLS streams on-device with a native-capable
Expo/React Native architecture: transport controls, a local queue, the four
play events, correct session replacement, graceful network handling, and no
simultaneous audio instances.

## Decision

**A framework-independent `PlaybackEngine` driven by a single `AudioDriver`,
adapted to `expo-audio` (Expo SDK 57).**

- `src/playback/PlaybackEngine.ts` holds all logic: queue, transport,
  session lifecycle, telemetry, and retries. It knows nothing about React
  Native. It is unit-tested with a fake driver and a fake API transport,
  and integration-tested against the real API with the same fake driver.
- `src/playback/expoAudioDriver.ts` is the *only* adapter to `expo-audio`.
  Exactly one native player exists at a time: `load()` destroys any previous
  player before `createAudioPlayer()` runs. There is no other path to native
  audio.
- `src/playback/provider.tsx` binds the engine to React via
  `useSyncExternalStore` and mounts it only while the auth status is
  `authenticated`. Sign-out unmounts the provider, which stops playback and
  releases the player.
- `expo-audio` 57.0.5 installed via `npx expo install` (SDK-pinned), plus its
  `expo-asset` peer dependency (Expo Doctor requirement).

### Session lifecycle

- Every track load mints a **fresh Phase 7 session**
  (`POST /v1/playback/sessions` with `{ trackId }`). The relative
  `hlsUrl` is resolved against the API base URL (ADR-004) — no string
  concatenation bugs, no token in logs or state: the raw token lives only
  inside the session-scoped HLS URL handed to the driver.
- **Teardown-before-replacement**: `loadTrackAt` destroys the current
  driver player (and drops its listener) *before* requesting the new
  session. Manual skip therefore never emits `COMPLETE`; only natural
  `didJustFinish` does.
- A monotonic `loadGeneration` counter invalidates stale async work:
  `stop()`/`destroy()`/superseding loads bump it, and continuations after
  session creation and after `driver.load()` bail out when stale. A
  `stop()` that wins the race against session creation leaves no player
  and no leaked session.
- The driver publishes its initial status **synchronously** inside
  `load()` (observed in `expo-audio` typings), so the resume target
  (`pendingSeekMs`) is assigned *before* `driver.load()` is called. A user
  seek issued while the session is being minted is preserved, not clobbered.

### Transport and queue

- Play/pause/toggle, `seekTo` (clamped to the known duration), `stop`,
  `next`, `previous`, `retry`, `setQueue`, `enqueue`, `clearQueue`.
- `previous()` restarts the current track when past 3 seconds; otherwise
  loads the previous track. At the head of the queue it restarts.
- Natural finish reports `COMPLETE` and auto-advances; the end of the
  queue releases the player and enters `ended` while keeping the queue for
  replay.

### Telemetry (ADR-006 events)

- `START` (once, position 0), `HEARTBEAT` (configurable cadence, default
  30 s), `COMPLETE` (natural finish only), `ERROR` (player error or load
  failure, with last-known position).
- All reporting is **fire-and-forget**: failures surface through
  `onEngineError` and never interrupt playback. Session-creation failure
  cannot emit an API `ERROR` event (no session id exists) — it is engine
  state only.
- The heartbeat timer runs only while playing; pause stops it and resume
  restarts it exactly once (guarded by `ensureHeartbeat()`).

### Foreground-only scope

Phase 8 is explicitly **foreground-only**:

- `expo-audio` config plugin: `enableBackgroundPlayback: false`,
  `recordAudioAndroid: false` (avoids background-audio services and the
  Android microphone permission).
- `setAudioModeAsync`: `playsInSilentMode: true`,
  `interruptionMode: 'doNotMix'`, `shouldPlayInBackground: false`.
- Seams are preserved for the future: the `AudioDriver` interface and the
  engine's lifecycle hooks are where background playback, lock-screen
  controls, CarPlay/Android Auto, and offline playback will attach. No
  background work is implemented now.

### Error recovery

- A driver error moves the engine to `error` and reports `ERROR` with the
  last position; `retry()` (also triggered by `play()` from error state)
  mints a **fresh session** and resumes at the last position via the
  pending-seek path.
- Network interruption surfaces as a driver error; the same retry path
  recovers without user bookkeeping.

## Alternatives considered

- **react-native-video / track-player**: `expo-audio` is the Expo-blessed
  module for SDK 57, HLS-capable via AVPlayer/ExoPlayer, and avoids
  third-party native maintenance. (Per AGENTS.md: prefer recommended Expo
  modules.)
- **Background playback now**: out of scope per the brief; the plugin and
  audio mode explicitly disable it to avoid accidental native service /
  permission footprint.

## Consequences

- Playback works only in the foreground; backgrounding the app stops
  audio (documented limitation, not a bug).
- The engine is UI-free; a player UI attaches later via `usePlayback()`.
- Session-per-track means skips mint sessions the backend never sees
  completed — consistent with ADR-006's fraud model (only completed /
  heartbeated sessions count).
