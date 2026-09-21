# ADR-009: Background audio and system media controls

Date: 2026-09-21
Phase: 10 — Background playback
Supersedes: nothing (extends ADR-007, which defined the playback engine)

## Context

Phase 8 built a foreground-only playback engine: the `expo-audio` config
plugin had `enableBackgroundPlayback: false` and the runtime audio mode set
`shouldPlayInBackground: false`. Phase 10 requires the music to keep playing
when the app backgrounds or the screen locks, with system media controls
(lock screen, Control Center, Android notification), correct iOS audio-session
integration, phone-call interruption handling, headphone/Bluetooth behavior,
and audio-focus pause/resume — all without creating a second audio engine and
without disturbing the queue, shuffle, repeat, or player UI from Phases 8–9.

## Decision

**Enable the background capability at the existing seams: the expo-audio
config plugin, the runtime audio mode, and one new driver method. The engine
stays the single source of truth; system transport events enter through the
same native status subscription that already drives the engine.**

### Config (build time)

- `app.json`: expo-audio plugin `enableBackgroundPlayback: true`
  (`recordAudioAndroid` stays `false`, so no microphone permission). The
  plugin generates, verified by prebuild inspection:
  - iOS `UIBackgroundModes: ["audio"]`
  - Android `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`
    permissions, and `expo.modules.audio.service.AudioControlsService`
    with `foregroundServiceType="mediaPlayback"`

### Runtime (per app launch)

- `setAudioModeAsync`: `shouldPlayInBackground: true` alongside the existing
  `playsInSilentMode: true` and `interruptionMode: 'doNotMix'`. Exclusive
  focus (`doNotMix`) is what makes the OS deliver interruptions and route
  changes to the native player.

### Driver contract (one additive method)

`AudioDriver.setNowPlaying(metadata | null)`:

- Non-null registers the single native player for lock-screen / Control
  Center / notification controls via
  `AudioPlayer.setActiveForLockScreen(true, metadata)`. On Android this also
  promotes the playback service to the foreground — the mechanism that keeps
  audio alive when the app backgrounds.
- Null clears the controls (`clearLockScreenControls`). Called before the
  native player is destroyed, so a stale track never lingers on the OS
  surface.
- Replacing metadata supersedes the previous registration (the old player is
  torn down first, per the Phase 8 single-player invariant); no intermediate
  clear between tracks.

### Engine behavior

- `loadTrackAt` publishes `toNowPlaying(track)` (title, artist, album,
  artwork URL) to the driver right after `driver.load` succeeds and before
  autoplay — the OS surface is correct from the first frame, including when
  backgrounded.
- `teardownTrack` clears the registration before destroying the player
  (skipped when nothing was ever registered), so stop / natural queue end /
  destroy leave no stale now-playing info.
- System transport (remote play/pause/seek) arrives as ordinary native
  status updates and flows through the existing `handleDriverStatus` — no
  parallel state, no second control path.
- The heartbeat cadence now follows actual playback: a native-initiated
  pause (interruption began, headphone unplug, remote pause, audio-focus
  loss) stops the HEARTBEAT timer exactly like `engine.pause()` does, and a
  native resume restarts it. Queue, position, shuffle, and repeat are never
  touched by these transitions.

## Native behavior (verified by reading expo-audio 57.0.5 source, not by device)

- iOS: `AVAudioSession` playback category; interruption begin pauses and
  resumes only on `.shouldResume`; `.oldDeviceUnavailable` (headphone /
  Bluetooth route removal) pauses; lock-screen controller handles play,
  pause, toggle, position change, optional ±10s skip.
- Android: transient/permanent audio-focus loss pauses (transient pause
  resumes on focus gain); foreground media-playback service while lock-screen
  controls are active; media session handles play/pause/seek.

## Known limitation (accepted by the "where supported" qualification)

expo-audio 57.0.5 (latest SDK 57 release) does not expose queue next/previous
callbacks: its iOS media controller registers no next/previous remote
commands, and its Android media-session callback explicitly removes
next/previous commands. System **next/previous cannot be wired** to
`PlaybackEngine.next()/previous()` through the supported API without patching
the library or writing a custom native module — both rejected as out of
proportion for this phase. Remote play/pause/seek work; next/previous remain
in-app only (mini/full player UI, queue view). Revisit when expo-audio adds
the callbacks or as a small native module in a later phase.

## Consequences

- Background-capable development builds are required to exercise this; the
  sandbox has no device, so physical behavior (actual background audio, lock
  controls, call interruption, headset buttons, focus with a real media app)
  is explicitly unverified — see PHASE-10-REPORT.
- No backend changes. No changes to the player UI (it subscribes to the same
  engine snapshots, which now also reflect system-initiated pauses).
- Out of scope, per the brief: CarPlay, Android Auto, offline downloads,
  subscriptions/payments, DRM, royalty math, recommendations, social.
