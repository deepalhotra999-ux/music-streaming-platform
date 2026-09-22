# Android Auto Setup Guide (Phase 24)

Android Auto (phone-projected) integration for the Waveform mobile app. This
guide covers how the integration is wired, what a development build needs,
and how to validate it on a real head unit or the Desktop Head Unit (DHU).

## What was built

A local **Android-only** Expo module
(`apps/mobile/modules/waveform-android-auto`) that exposes Waveform to
Android Auto through a Media3 `MediaLibraryService` /
`MediaLibrarySession`. The native side owns **no decoder, no audio focus,
and no queue of its own**: it runs a virtual `SimpleBasePlayer` that
projects the one real `PlaybackEngine` (JS) and forwards every car-side
command to it as a bridge event.

The JavaScript layer (`apps/mobile/src/androidauto/`) reuses the existing
catalog/library APIs, the shared `PlaybackEngine`, HLS sessions, telemetry,
authentication, and server-authoritative subscription enforcement. Android
Auto is a remote control for the one player — not a second player.

Full architecture rationale: `docs/adr/018-android-auto-integration.md`.

## Build requirements

Android Auto requires a **development build** (not Expo Go):

```bash
cd apps/mobile
npx expo run:android --device
# or
eas build --profile development --platform android
```

The local native module is picked up automatically by Expo module
autolinking — no config-plugin entry is needed (verify with
`npx expo-modules-autolinking search --platform android`; it should list
`waveform-android-auto` with `platforms: ['android']`). Its library
manifest declares the `WaveformMediaLibraryService` (exported, with the
Media3 `MediaLibraryService` + legacy browse intent filters and
`foregroundServiceType="mediaPlayback"`), and the
`com.google.android.gms.car.application` meta-data points at
`res/xml/automotive_app_desc.xml`, which declares only the `media` app
category.

No extra permissions were added. Background-audio permissions
(`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`) come from the
existing expo-audio config plugin (Phase 10). There is deliberately:

- no `android.hardware.type.automotive` feature (that targets Android
  Automotive OS builds, which are out of scope — phone-projected only),
- no microphone permission,
- no Automotive OS module, settings UI, or distribution configuration.

The module pins `androidx.media3:media3-session:1.9.0` — the exact Media3
version expo-audio 57.0.5 ships — so Gradle never has to resolve
conflicting Media3 copies.

## Google Play requirements

Before an Android Auto media app can reach users:

1. **Add the car app descriptor** — already done in this module
   (`automotive_app_desc.xml` with `<uses name="media"/>`).
2. **Opt in on Play Console** — Release → Setup → Advanced settings →
   Form factors → Android Auto → opt in, and complete the media-app
   declaration questionnaire.
3. **Quality review** — Android Auto media apps go through Google's car-app
   quality review (browse hierarchy, playback controls, metadata/artwork,
   error states, no driver distraction issues). The six-node root
   (Home, Recently played, Liked, Playlists, Artists, Albums) plus search
   is designed to satisfy the media template requirements.
4. **Testing tracks** — distribute the dev build via internal testing and
   verify on real head units before the review submission.

## Testing

### Desktop Head Unit (DHU)

1. Install the DHU from the Android SDK (`extras/google/auto`).
2. Enable developer mode on the phone: tap the Android Auto app version
   10 times, then enable "Unknown sources" in the overflow menu.
3. Connect via ADB: `adb forward tcp:5277 tcp:5277`, then run `desktop-head-unit`.
4. Install the Waveform development build on the phone, sign in, then open
   the app on the DHU.

### Real head unit

1. Install the development build on the phone and sign in to Waveform.
2. Connect the phone to the car (USB or wireless Android Auto).
3. Waveform appears in the car's media source list.

### What to verify (manual checklist)

- [ ] Root shows exactly the six nodes: Home/discovery, Recently played,
      Liked tracks, Playlists, Artists, Albums.
- [ ] Signed out (or fresh install, car connected before sign-in): the car
      shows the sign-in-required message, no private data, no crash.
- [ ] Tapping a track plays it through the car's speakers with correct
      title/artist/artwork and duration.
- [ ] Play/pause/next/previous/seek from the car UI drive the phone's
      playback engine (check the phone's Now Playing stays in sync).
- [ ] Previous restarts the track when >3s in (matches phone behavior).
- [ ] Shuffle and repeat (off/all/one) toggle from the car and persist.
- [ ] Position/progress advances on the car UI while playing.
- [ ] Search (voice or head-unit keyboard) returns Waveform results;
      tapping a result plays it.
- [ ] TAKEDOWN track (or one deleted between browse and tap) fails with a
      friendly error, never silence or a crash.
- [ ] Inactive subscription: tapping play shows the subscription message
      directing the user to the Waveform app (no purchase UI in the car).
- [ ] Sign out on the phone: the car UI falls back to the sign-in gate.

## Troubleshooting

- **App doesn't appear in Android Auto:** the debug DHU requires the
  "unknown sources" developer setting; release builds need the Play
  Console opt-in + review. Also confirm the merged manifest contains the
  service (inspect the APK's `AndroidManifest.xml` after a Gradle build).
- **Browse shows the sign-in gate despite being signed in:** the JS
  controller attaches `notifyAuthState(true)` when the authenticated
  `PlaybackProvider` shell mounts. If the car connected before JS
  finished launching, the gate clears as soon as the controller attaches.
- **Commands do nothing:** the virtual player forwards everything to JS;
  if the JS bridge never attached (Expo Go, or the module missing from
  the build), events go nowhere. Use a development build.

## Known limitations (Phase 24)

- The Kotlin has **not been compiled** (no Android SDK in this
  environment) and nothing has run against a real head unit or the DHU.
  Treat the native side as unvalidated until the checklist above passes.
- Queue editing from the car is not advertised — the engine queue is the
  single source of truth ("support where available").
- Voice search is host-driven through the media-service search API; there
  is no in-car text-entry UI from Waveform (per platform rules).
