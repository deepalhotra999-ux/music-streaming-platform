# Phase 10 Report — Background playback & system media controls

Date: 2026-09-21
Base: `0f1b1bb` (Phase 9)
Status: complete, untested on physical hardware (see limitations)

## What was built

Background audio and system media controls, wired through the existing
Phase 8 playback engine — no second audio engine, no UI changes:

1. **Background capability enabled**
   - `app.json`: expo-audio plugin `enableBackgroundPlayback: true`
     (`recordAudioAndroid` stays `false`).
   - Runtime audio mode: `shouldPlayInBackground: true` (kept
     `playsInSilentMode: true`, `interruptionMode: 'doNotMix'`).
   - Prebuild-verified native output: iOS `UIBackgroundModes: ["audio"]`;
     Android `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK`
     permissions and `AudioControlsService` with
     `foregroundServiceType="mediaPlayback"`.

2. **Now-playing / lock-screen registration**
   - New `AudioDriver.setNowPlaying(metadata | null)` contract
     (`NowPlayingMetadata`: title, artist, albumTitle, artworkUrl).
   - `expoAudioDriver` implements it via
     `AudioPlayer.setActiveForLockScreen(true, metadata)` /
     `clearLockScreenControls()` — on Android this also promotes the
     playback service to the foreground, which is what keeps audio alive
     when the app backgrounds.
   - `PlaybackEngine.loadTrackAt` publishes the track's metadata right after
     `driver.load` succeeds and before autoplay; `teardownTrack` clears it
     before destroying the player (skipped when nothing was registered).
   - Single-player invariant preserved: teardown-before-replacement, one
     native player at a time; metadata replacement supersedes, never stacks.

3. **System transport + interruptions flow through existing status**
   - Remote play/pause/seek arrive as native status updates and go through
     the same `handleDriverStatus` as everything else — no parallel state.
   - iOS behavior (from expo-audio 57.0.5 native source): playback-category
     audio session; interruption begin pauses, resume only on
     `.shouldResume`; `.oldDeviceUnavailable` pauses (headphone/Bluetooth
     route removal); lock screen handles play/pause/toggle/seek/±10s.
   - Android behavior (same source): transient/permanent audio-focus loss
     pauses, transient pause resumes on focus gain; foreground
     media-playback service while lock-screen controls are active.
   - Engine change: the HEARTBEAT cadence now follows actual playback — a
     native-initiated pause stops it like `engine.pause()` does; a native
     resume restarts it. Queue, position, shuffle, repeat are untouched by
     these transitions.

4. **Docs**: ADR-009 (`docs/adr/009-background-playback.md`).

## Acceptance criteria

- [x] Config + runtime enable background audio (verified by prebuild output).
- [x] Single native player / single engine preserved; queue, shuffle, repeat,
      single-player invariant unchanged.
- [x] Now-playing metadata published on load, replaced on track change,
      cleared on stop / natural end / destroy.
- [x] Native-initiated pause/resume reflected in engine state and telemetry
      (unit-tested via simulated status updates).
- [x] Mini/full player UI unchanged — it subscribes to the same engine.
- [x] No second audio engine; no backend changes; out-of-scope items untouched.

## Tests

- New `src/playback/__tests__/BackgroundPlayback.test.ts` (11 tests):
  now-playing publish/replace/clear lifecycle, mapping of missing optional
  metadata, native-pause → `paused` + heartbeat stops + queue/position/
  shuffle/repeat preserved, native-resume → `playing` + heartbeat restarts,
  engine controls work after a native pause, pause-during-buffering.
- New `src/playback/__tests__/expoAudioDriver.test.ts` (5 tests): audio-mode
  flags, `setActiveForLockScreen` metadata mapping (nulls → undefined),
  `clearLockScreenControls` on null, no-ops without a loaded player.
- Full mobile unit suite: **207/207 pass** (191 before + 16 new).
- Live tests vs real API: **12/12 pass** (unchanged behavior confirmed).
- `tsc --noEmit`: clean. ESLint: clean. Expo Doctor: **21/21**.
- `expo prebuild` (all platforms): native config verified as above;
  generated `android/`/`ios/` removed afterward (gitignored, per project
  convention).
- `expo export` for android + ios: both succeed; export dirs removed.

## Manual checklist

Not executable in this sandbox (no device, no OS-level audio):

- [ ] Real audio continues after backgrounding the app
- [ ] Real audio continues with the screen locked
- [ ] Lock screen / Control Center / notification show title/artist/artwork
      and play/pause/seek respond
- [ ] Incoming phone call pauses; resume follows iOS `.shouldResume`
- [ ] Headphone/Bluetooth disconnect pauses playback
- [ ] Headset/Bluetooth play/pause button works
- [ ] Second media app takes audio focus: pause on loss, resume on
      transient-loss gain (Android)
- [ ] Track change while backgrounded keeps the foreground service alive

## Known issues / limitations

1. **System next/previous are not available.** expo-audio 57.0.5 (latest SDK
   57 release) does not expose queue callbacks: iOS registers no
   next/previous remote commands; Android explicitly removes them. Wiring
   them would require patching the library or a custom native module.
   Accepted under the brief's "where supported"; remote play/pause/seek work.
   Tracked in ADR-009 for a later phase.
2. **No physical testing was possible.** The sandbox has no iPhone, no
   Android device/emulator, no Android SDK, no Xcode. Everything above the
   native line is verified (unit tests, generated config inspection); actual
   background audio, lock controls, interruptions, headset behavior, and
   foreground-service behavior under real OS restrictions are unverified.
   Do not claim background playback works until tested on hardware.
3. iOS `Info.plist` contains Expo's template `NSMicrophoneUsageDescription`
   boilerplate; no microphone permission is requested (Android manifest has
   no `RECORD_AUDIO`; iOS recording is disabled). Pre-existing template
   behavior, not a Phase 10 regression.
4. Brief inter-track gap in the OS surface: the old registration clears
   during the session-mint/load window before the new one registers. The
   lock screen briefly shows nothing rather than a stale track. (Same window
   applies to the Android foreground notification.)

## Files created

- `docs/adr/009-background-playback.md`
- `docs/PHASE-10-REPORT.md` (this file)
- `apps/mobile/src/playback/__tests__/BackgroundPlayback.test.ts`
- `apps/mobile/src/playback/__tests__/expoAudioDriver.test.ts`

## Files modified

- `apps/mobile/app.json` — expo-audio plugin `enableBackgroundPlayback: true`
- `apps/mobile/jest.setup.js` — expo-audio mock: `setActiveForLockScreen`,
  `updateLockScreenMetadata`, `clearLockScreenControls`, `addListener`,
  `currentStatus`
- `apps/mobile/src/playback/types.ts` — `NowPlayingMetadata`,
  `AudioDriver.setNowPlaying`
- `apps/mobile/src/playback/index.ts` — export `NowPlayingMetadata`
- `apps/mobile/src/playback/expoAudioDriver.ts` —
  `shouldPlayInBackground: true`; `setNowPlaying` implementation
- `apps/mobile/src/playback/PlaybackEngine.ts` — publish metadata on load,
  clear on teardown, heartbeat follows native pause
- `apps/mobile/src/playback/__tests__/fakeDriver.ts` — `setNowPlaying`
  recording

## Physical device requirements (to verify before claiming it works)

- iPhone (physical; simulator cannot test background audio faithfully):
  backgrounding, screen lock, Control Center controls, phone-call
  interruption, headphone/Bluetooth disconnect and buttons, silent switch.
- Android device (physical or emulator with audio): backgrounding, lock,
  media notification controls, audio-focus vs a real media app, Bluetooth
  disconnect, foreground-service behavior under battery optimization.
- A development build (`expo run:ios` / `expo run:android` or EAS) — Expo Go
  cannot run the native audio module.
