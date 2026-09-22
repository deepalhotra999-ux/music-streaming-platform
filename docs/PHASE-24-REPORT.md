# Phase 24 Report: Android Auto Audio Integration

**Date:** 2026-09-22
**Status:** Complete (with honest limitations documented below)
**Commit:** (to be filled on commit)

## Summary

Phase 24 adds **phone-projected Android Auto** audio integration to the
Waveform mobile app through a real Media3 `MediaLibraryService` (not a
fake screen). The implementation reuses the existing `PlaybackEngine`,
queue, HLS sessions, telemetry, authentication, entitlement enforcement,
and server-authoritative subscription checks. Android Auto is a remote
control for the one player — not a second player.

## What was built

### Local Expo module (`apps/mobile/modules/waveform-android-auto/`)

- `package.json`, `expo-module.config.json` — Android-only module
  definition (`platforms: ["android"]`); iOS/CarPlay untouched
- `src/index.ts` — TypeScript bridge interface (6 events up, 8 functions
  down)
- `android/build.gradle` — Pins `androidx.media3:media3-session:1.9.0`
  (exactly expo-audio 57.0.5's Media3; no exoplayer/ui/datasource
  artifacts — the module never decodes audio)
- `android/src/main/AndroidManifest.xml` — Declares
  `WaveformMediaLibraryService` (exported, `foregroundServiceType=
  "mediaPlayback"`, Media3 + legacy browse intent filters) and the
  `com.google.android.gms.car.application` meta-data
- `android/src/main/res/xml/automotive_app_desc.xml` — Declares only
  `<uses name="media"/>`. No `android.hardware.type.automotive` feature
  (Automotive OS out of scope), no microphone or other permissions
- Kotlin:
  - `AutoPlayer.kt` — Virtual player on `SimpleBasePlayer` (Media3 1.9.0):
    projects the JS engine's playlist/state/position, forwards every
    command to JS as a bridge event. Owns no decoder or audio focus
  - `WaveformMediaLibraryService.kt` — `MediaLibraryService` owning the
    session; routes JS resolutions into the virtual player on the main
    looper; sign-in gating
  - `WaveformLibraryCallback.kt` — `MediaLibrarySession.Callback`:
    browse/item/search/play requests become JS events resolved via
    `ListenableFuture` (8s timeout, safe fallbacks); unsigned callers get
    the sign-in gate
  - `AutoBridge.kt` — Singleton linking service ↔ module; no-op without
    a JS listener (cold start never crashes)
  - `AutoMediaIds.kt` — `waveform:`-namespaced id parsing (never trusted
    as authorization)
  - `WaveformAndroidAutoModule.kt` — Expo module: 6 declared events, 8
    projection/resolution functions
- `__tests__/manifest.test.js` — 12 static tests pinning the manifest,
  descriptor, permissions, module boundaries, and event declarations

### JavaScript layer (`apps/mobile/src/androidauto/`)

- `nativeBridge.ts` — Safe native module accessor (null off Android)
- `identifiers.ts` — Node/item ID parsing and construction
- `contentProvider.ts` — Maps catalog/library APIs onto the required
  six-node tree: Home/discovery, Recently played, Liked tracks,
  Playlists, Artists, Albums. READY-only tracks; playlist visibility
  stays server-side (private playlists 404 for non-owners)
- `controller.ts` — Event handler: resolves browse/search/play via the
  provider, drives the shared engine (`setQueue`), forwards
  play/pause/stop/prepare/next/previous/restart/seek/set-item/shuffle/
  repeat, projects engine snapshots back to native
- `AndroidAutoHost.tsx` — React host, mounts in the authenticated shell
- `index.ts` — Public exports
- `__tests__/` — 3 suites, 28 tests (identifiers, content provider,
  controller: attach/detach, browse, item lookup incl. search
  registration, play incl. takedown/locked paths, transport, snapshot
  sync, voice search)

### Shared wiring

- `apps/mobile/src/app/_layout.tsx` — Mounts `<AndroidAutoHost />`
  beside `<CarPlayHost />` inside the authenticated `PlaybackProvider`
  shell (sign-out unmounts it)
- `apps/mobile/package.json` / `package-lock.json` — Added
  `waveform-android-auto: file:./modules/waveform-android-auto`
- `apps/mobile/eslint.config.mjs` — Node/jest globals for the module's
  static tests (mirrors the CarPlay plugin-test override)
- `apps/mobile/app.json` — Prettier formatting normalization only; the
  module needs **no config-plugin entry** (autolinked native library)

## Acceptance criteria

### ✅ Real Android Auto media service (not fake UI)

- Native Kotlin `MediaLibraryService` + `MediaLibrarySession` with the
  official manifest declaration and car-application descriptor
- Browse tree, search, transport, and queue all served through Media3
- No React Native views rendered in the car; JS only supplies data

### ✅ One player, one queue, one session, one login

- Play requests call `engine.setQueue()` on the shared `PlaybackEngine`
- No second audio player, no Auto-specific HLS URLs, no duplicated
  session/entitlement/telemetry/audio-focus logic
- `expo-audio` remains the only real player and focus owner
- Signed-out/cold-start: native serves the sign-in-required gate, no
  private data, no crash, no extra player

### ✅ Server-authoritative enforcement

- Media ids are parsed, never trusted: play requests re-resolve context
  from fresh server fetches (READY-only) or cached search results
- Subscription lock is server-side; the car shows the subscription
  message (no purchase UI in the car)
- Private playlists resolve through `getPlaylist`, which 404s for
  non-owners — invisible in browse and search
- TAKEDOWN/deleted tracks: refresh-before-play plus the engine's fresh
  HLS session per track fail safe (friendly error, never stale playback)

### ✅ Full state synchronization

- Item, playback state, metadata/artwork, duration, position (with
  wall-clock extrapolation between pushes), queue, active index,
  shuffle/repeat, errors, stop, and sign-out are all projected
- Successful play clears any previously projected error

### ✅ Transport coverage (where supported)

- play, pause, stop, prepare, next, previous (with the engine's existing
  >3s restart semantics), seek, set-media-item, shuffle, repeat
  off/all/one
- Queue editing is not advertised (engine queue is the single source of
  truth); `onAddMediaItems` resolves empty. Search uses the supported
  media-service search API; no in-car text-entry UI

### ✅ Narrow, Android-only boundary

- `platforms: ["android"]`; JS bridge returns null off Android
- No Automotive OS module/settings/UI/distribution, no iOS changes
- No credentials, permanent audio URLs, token logging, microphone
  permission, or unrelated permissions (pinned by static tests)

## Correctness fixes applied (this turn)

1. **AutoPlayer rebuilt on `SimpleBasePlayer`:** the first draft
   extended `BasePlayer` and overrode methods that are `final` in Media3
   1.9.0 — it could not compile. Verified against the 1.9.0 sources
   (from the Maven sources jars): `SimpleBasePlayer` is the designed
   base for projected players — one `getState()` snapshot plus single
   `handle*` overrides; the custom `AutoTimeline` subclass was deleted
   (Media3 builds its own `PlaylistTimeline` from `MediaItemData`).
2. **Missing `Events(...)` declaration:** the Expo module called
   `sendEvent` without declaring events, which would have dropped every
   native→JS event. All 6 events are now declared and pinned by a static
   test that cross-checks against the JS controller's subscriptions.
3. **Thread-safety on sign-out:** `setSignedIn` can arrive on the JS
   thread; it now hops to the player thread before touching the virtual
   player (whose projection methods verify the application thread).
4. **Search registration:** voice-search results are now entered in the
   advertised-item registry so later `onGetItem` calls answer without
   new network calls (covered by a controller test).
5. **`onAddMediaItems` semantics:** resolves empty instead of emitting a
   queue-add event the JS side ignores — no phantom round-trip.
6. **Stale-cache fail-safe documented:** the refresh-failure fallback is
   explicitly safe because the engine mints a fresh HLS session per
   track; a taken-down track fails session creation and surfaces as a
   friendly error.

## AUTOMATED VERIFIED

### Unit tests

- **Full mobile suite:** 67 suites, 513 tests — all pass (includes 28
  Android Auto JS tests + 12 native-module static tests).
- **Android Auto JS:** 3 suites, 28 tests — all pass
  - `controller.test.ts` (attach/detach, browse, item lookup + search
    registration, play incl. takedown/locked paths, transport/seek/mode
    commands, snapshot sync with queue dedupe, voice search)
  - `contentProvider.test.ts` (six-node tree, READY filtering, empty
    states, id parsing safety)
  - `identifiers.test.ts` (construction/parsing round-trips)
- **Native static tests:** 1 suite, 12 tests — all pass (service
  declaration, intent filters, descriptor = media only, no Automotive
  feature, no permissions, Android-only platform, Media3 pin without
  decoder artifacts, `SimpleBasePlayer` architecture, event declarations)
- **Backend:** 324/325 pass. The single failure is the known pre-existing
  analytics UTC-day test (`trend > buckets plays by UTC day`), left
  untouched per phase protocol.
- **Admin:** 36/36 pass; `npm run build` green.

### Static analysis

- **TypeScript (mobile):** `npx tsc --noEmit` — 0 errors
- **TypeScript (backend):** `tsc --noEmit -p tsconfig.check.json` — 0
  errors; `npm run build` green
- **ESLint:** 0 errors on all changed files (mobile); backend `eslint
  src` clean
- **Prettier:** all changed files conform

### Expo / native integration (static)

- **Expo Doctor:** 20/21 checks pass. Sole failure is the pre-existing
  direct `expo-modules-core` dependency from the Phase 23 baseline.
- **Autolinking:** `expo-modules-autolinking search --platform android`
  lists `waveform-android-auto` with `platforms: ['android']`, no
  duplicates.
- **Expo config:** exports cleanly; `app.json` has no Android Auto
  config-plugin entry (correct — the library manifest merges through
  autolinking), `waveform-carplay` plugin entry unchanged.
- **Security scan:** no `RECORD_AUDIO`, no `<uses-permission>`, no
  Automotive feature, no secrets/tokens/URLs anywhere in the module or
  JS bridge (only negative test pins mention them).

## REQUIRES REAL ANDROID AUTO/SIMULATOR TESTING

The following cannot be verified in this Linux sandbox (no Android SDK,
no emulator, no DHU, no head unit, no Kotlin compiler):

### Native compilation

- Kotlin (~700 lines across 6 files) has not been compiled. Every
  Media3 1.9.0 API used (`SimpleBasePlayer` + `State`/`MediaItemData`
  builders, all `handle*` signatures, `LibraryResult` factories,
  `MediaLibrarySession.Builder`) was verified line-by-line against the
  1.9.0 sources, but a real `kotlinc`/Gradle build is still required.
- **Action:** run a development build (`npx expo run:android`) on a
  machine with the Android SDK.

### Head-unit behavior

- Browse tree rendering, search UX, transport buttons, Now Playing
  metadata/artwork/position, queue display, error surfaces, sign-in
  gate, and sign-out transitions.
- **Action:** follow `docs/ANDROID-AUTO-SETUP.md` (DHU or real head
  unit) and run the manual checklist there.

### Play Console flow

- Car-app declaration questionnaire and Google's Android Auto quality
  review have not been started.
- **Action:** `docs/ANDROID-AUTO-SETUP.md` steps 1–4.

## Files created

```
apps/mobile/modules/waveform-android-auto/
  package.json
  expo-module.config.json
  src/index.ts
  android/build.gradle
  android/src/main/AndroidManifest.xml
  android/src/main/res/xml/automotive_app_desc.xml
  android/src/main/java/com/musicstreaming/waveform/auto/
    AutoPlayer.kt
    WaveformMediaLibraryService.kt
    WaveformLibraryCallback.kt
    AutoBridge.kt
    AutoMediaIds.kt
    WaveformAndroidAutoModule.kt
  __tests__/manifest.test.js

apps/mobile/src/androidauto/
  nativeBridge.ts
  identifiers.ts
  contentProvider.ts
  controller.ts
  AndroidAutoHost.tsx
  index.ts
  __tests__/identifiers.test.ts
  __tests__/contentProvider.test.ts
  __tests__/controller.test.ts

docs/adr/018-android-auto-integration.md
docs/ANDROID-AUTO-SETUP.md
docs/PHASE-24-REPORT.md (this file)
```

## Files modified

```
apps/mobile/package.json — Added waveform-android-auto file: dependency
apps/mobile/package-lock.json — Lockfile entries for the local module
apps/mobile/eslint.config.mjs — Node/jest globals for module static tests
apps/mobile/app.json — Prettier formatting normalization (no plugin entry)
apps/mobile/src/app/_layout.tsx — Mount AndroidAutoHost in auth shell
apps/mobile/src/androidauto/contentProvider.ts — advertiseItems + docs
apps/mobile/src/androidauto/controller.ts — search registration, takedown
  fail-safe docs, item test assertion
docs/adr/018-android-auto-integration.md — SimpleBasePlayer decision,
  onAddMediaItems/onSetMediaItems semantics, sign-in gate wording
```

## Deliberately not built (per brief)

Android Automotive OS (separate module/OS build/settings/sign-in UI),
distribution configuration, artist management/royalties/analytics/
moderation/Admin surfaces in the car, subscription-management forms,
React Native text-entry UI in the car, queue editing from the car, any
iOS changes, any backend changes.
