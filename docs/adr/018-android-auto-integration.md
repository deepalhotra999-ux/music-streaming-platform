# ADR-018: Android Auto audio integration (phone-projected)

Date: 2026-09-22
Phase: 24 — Android Auto Audio Integration (phone-projected only)
Supersedes: nothing (builds on ADR-007, ADR-009, ADR-014, ADR-017)

## Context

Phase 24 must provide a proper Android Auto audio experience that reuses the
existing `PlaybackEngine`/`PlaybackProvider` (ADR-007), the Phase 10 Android
background-audio + notification integration (ADR-009), the Phase 5 session
model, and the server-authoritative subscription entitlement (ADR-014). It
must mirror the Phase 23 CarPlay architecture (ADR-017) — JS owns content
and playback decisions; native owns the car surface — while respecting that
Android Auto's car UI is rendered by the Android Auto host from a
`MediaLibrarySession`, not from app-owned templates.

Android Auto (phone-projected) needs no approval, unlike CarPlay: declaring
the media capability in the manifest is sufficient. Android Automotive OS
(distinct platform, separate APK/module) is explicitly out of scope for this
phase.

There is no Android SDK/Xcode in this environment, so the Kotlin code cannot
be compiled here. It is written against the long-stable Media3 session APIs
and aligned to the exact Media3 version expo-audio 57.0.5 already ships
(`1.9.0`), so no dependency version conflicts are introduced.

## Decision

**Hand-rolled, Android-only Expo module (`modules/waveform-android-auto`)
with a `MediaLibraryService` over a virtual Media3 `Player` that projects
the JS `PlaybackEngine`. No third-party Android Auto dependency.**

### Native module (Kotlin, Android only)

- `modules/waveform-android-auto/` is a local Expo module
  (`expo-module.config.json` declares `platforms: ["android"]`; autolinked
  via a `file:` dependency). iOS builds are unaffected: no iOS sources exist
  and the JS wrapper returns `null` off Android.
- `WaveformMediaLibraryService : MediaLibraryService` owns the
  `MediaLibrarySession` lifecycle. It is declared in the module's own
  `AndroidManifest.xml` (merged into the app manifest at build time) with
  the `androidx.media3.session.MediaLibraryService` + legacy
  `android.media.browse.MediaBrowserService` intent filters,
  `android:exported="true"`, and `foregroundServiceType="mediaPlayback"`.
- `res/xml/automotive_app_desc.xml` declares `<uses name="media"/>` and is
  referenced from the merged manifest via the standard
  `com.google.android.gms.car.application` meta-data. No
  `android.hardware.type.automotive` feature is declared (that would target
  Automotive OS builds); no microphone or other permissions are added.
- `AutoPlayer : SimpleBasePlayer` is a **virtual player**: it holds no audio
  resources and never decodes anything. (`SimpleBasePlayer` is Media3's
  purpose-built base for state-projected players: the whole `Player`
  contract is derived from one immutable `State` snapshot, and every
  command funnels into a single `handle*` override. Extending raw
  `BasePlayer` was rejected — its public convenience methods are `final`
  in Media3 1.9.0, so the overrides would not compile.) It keeps a
  projected state (playlist, index, playback state, position, duration,
  shuffle/repeat) and:
  - forwards transport commands (`play`, `pause`, `seekTo`, next/previous,
    shuffle, repeat, set-media-items) to JS as bridge events, where the
    controller invokes the real `PlaybackEngine`;
  - publishes state pushed from JS (`updatePlaybackState`, `updateQueue`,
    `updateRepeatShuffle`) by rebuilding the `State` snapshot and calling
    `invalidateState()`, which the `MediaLibrarySession` relays to the car
    host. The queue is expressed as `SimpleBasePlayer.MediaItemData`
    entries, so Media3 builds its own `PlaylistTimeline` — no custom
    `Timeline` subclass is needed.
  - position between JS pushes is extrapolated on the wall clock and
    clamped to the projected track duration.
- `WaveformLibraryCallback : MediaLibrarySession.Callback` answers
  `onGetLibraryRoot` / `onGetChildren` / `onGetItem` / `onSearch` /
  `onGetSearchResult` by emitting request events to JS and completing the
  returned `ListenableFuture` when JS resolves (or on an 8s timeout with a
  safe fallback). `onSetMediaItems` forwards the tapped media id to JS,
  which queues through the engine; the subsequent `player.setMediaItems`
  call from the session is swallowed once (via
  `suppressNextSetMediaItems`) so it cannot re-forward or loop.
  `onAddMediaItems` resolves with an empty list — queue editing is not
  advertised and the engine queue stays the single source of truth.
- `AutoBridge` (object singleton) links the service and the Expo module
  without either holding the other strongly. `sendEvent` with no JS
  listener is a safe no-op, so cold-start (car connects before JS runs) or
  a signed-out user degrades to the sign-in-required gate, never a crash.

### Why a virtual player (and not ExoPlayer)

Media3's session architecture requires a `Player` instance, but creating a
real ExoPlayer would be a **second audio player** alongside expo-audio's —
violating the single-player invariant (ADR-007) and duplicating HLS session
creation, entitlement checks, telemetry, and audio-focus handling. The
virtual player is the smallest honest adapter: the car host gets a fully
functional `MediaLibrarySession`; every command lands in the one
`PlaybackEngine`; every state change is a projection of engine snapshots.
expo-audio remains the only object that touches audio hardware, so Phase 10
background playback, audio focus, and interruption behavior are unchanged.

### JS controller (`src/androidauto/`)

Mirrors `src/carplay/`:

- `AndroidAutoContentProvider` maps the same catalog/library APIs to a
  driver-safe Media3 browse tree: root → Home, Recently Played, Liked
  Songs, Playlists, Artists, Albums; drill-down into albums, playlists,
  artists. Only `READY` tracks are offered; private playlists resolve
  through server-gated `getPlaylist` (404 for non-owners); empty nodes
  return a friendly message row.
- `AndroidAutoController` answers native browse/play/command/search
  requests, invokes the shared engine for every selection (same queue, same
  HLS session flow, same telemetry), and pushes engine snapshots back as
  playback-state/queue/repeat-shuffle updates. Track selection always
  refreshes the node's track list before queueing (takedown safety, as in
  Phase 23). Post-`setQueue` snapshot inspection maps `locked` →
  subscription-denied and `error` → playback-failure results.
- Voice search (`onSearch`) is implemented through the sanctioned
  media-session search path reusing Phase 12 `searchCatalog` (tracks as
  playable results; albums/artists/playlists as browsable containers).
  There is no in-car text entry anywhere.
- `AndroidAutoHost` mounts inside the authenticated `PlaybackShell`
  alongside `CarPlayHost`; sign-out detaches and tells native to show the
  safe gate. The late-engine-registration race is handled with the same
  `subscribeEngine` mechanism as Phase 23.

### Cold start

Android Auto may bind the service before any React Native UI has mounted
(or before the user ever opened the app). The service initializes its
session over an idle virtual player unconditionally; browse requests
without an attached JS side complete immediately with the signed-out root;
transport commands are safe no-ops until JS attaches and pushes a full
sync. No credentials ever live in native code; the API client stays in JS.

## Alternatives considered

- **Real ExoPlayer in the service, fed the engine's HLS URLs**: rejected —
  second player, duplicated session/entitlement/telemetry logic, fights
  expo-audio for audio focus.
- **Reusing expo-audio's internal player for the session**: rejected — its
  player instance is private to the expo-audio module and it declares no
  `MediaLibraryService`; not extensible.
- **react-native-track-player or similar**: rejected — would replace the
  proven Phase 8–10 engine instead of reusing it.
- **Deferring search**: considered; implemented instead via the sanctioned
  voice-search path since it reuses `searchCatalog` with a tiny native
  surface and no unsafe UI.

## Consequences

- Android Auto browsing/playback flows through the existing engine, session
  creation, entitlement checks, and telemetry. No backend changes.
- The Kotlin (~700 lines) ships uncompiled (no Android SDK here); it is
  written against long-stable Media3 APIs, kept minimal, and covered by
  JUnit stubs for a future Android build plus full JS-side unit tests with
  a mocked native module and a static manifest/descriptor assertion suite.
- Without a real Android Auto emulator/device validation pass, Android Auto
  is **not production-ready**; the report distinguishes AUTOMATED VERIFIED
  from REQUIRES REAL ANDROID AUTO/SIMULATOR TESTING.
- New native surface to maintain: media service, virtual player, session
  callback, bridge module — all Android-scoped and documented. iOS/CarPlay
  untouched.
