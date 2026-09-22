# ADR-017: Apple CarPlay audio integration

Date: 2026-09-22
Phase: 23 — Apple CarPlay Audio Integration
Supersedes: nothing (builds on ADR-007, ADR-009, ADR-014)

## Context

Phase 23 must provide a proper CarPlay audio experience that reuses the
existing `PlaybackEngine`/`PlaybackProvider` (ADR-007), the Phase 10
background-audio + Now Playing integration (ADR-009), the Phase 5 session
model, and the server-authoritative subscription entitlement (ADR-014).
CarPlay is an Apple-gated capability: audio apps need the
`com.apple.developer.carplay-audio` entitlement, which Apple grants per
Developer team after a manual request — it cannot be self-issued, and
without it the app simply never appears in CarPlay (compiles fine,
invisible at runtime). There is no Xcode/device in this environment, so
native code cannot be compile-tested here.

A research pass (see `docs/PHASE-23-REPORT.md`, "Research") established:

- No Expo-maintained CarPlay solution exists. `react-native-carplay`
  (birkir) is unmaintained since ~2023, old-architecture only, and its
  README disclaims Expo support; forks (`@g4rb4g3`, `@iternio`,
  `dotommy/react-native-automotive`) are unverified against Expo SDK 57 /
  unpublished. Depending on any of them would trade a small amount of
  hand-written Swift for an unmaintained native dependency with an
  uncertain new-architecture story.
- For audio apps, CarPlay's Now Playing screen is driven by the **same
  `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` stack as the lock
  screen** — the Phase 10 `setNowPlaying` publishing already paints
  CarPlay Now Playing with zero extra metadata path.
- Audio-entitled apps may use alert, grid, list, tab-bar, and Now Playing
  templates. `CPSearchTemplate` is a navigation-category template and is
  not available under the audio entitlement; the Apple-sanctioned
  audio-app search is Siri via an Intents extension — a separate native
  deliverable. Typed in-CarPlay search is therefore deferred.
- `CPNowPlayingTemplate.shared` is a singleton that must be pushed onto a
  browsable root, never set as root.

## Decision

**Hand-rolled, flag-gated CarPlay integration: a local iOS-only Expo
module (`modules/waveform-carplay`) plus a narrow JS controller
(`apps/mobile/src/carplay/`). No third-party CarPlay dependency.**

### Native module (Swift, iOS only)

- `modules/waveform-carplay/` is a local Expo module (`expo-module.config.json`
  declares `platforms: ["ios"]`; autolinked via a `file:` dependency).
  Android builds are unaffected: no Android sources exist and the JS
  wrapper returns `null` off iOS.
- `CarPlaySceneDelegate` (`@objc(WaveformCarplaySceneDelegate)`,
  `CPTemplateApplicationSceneDelegate`) owns the `CPInterfaceController`
  lifecycle only. A shared `CarPlayCoordinator` (app-lifetime singleton)
  bridges the UIKit-instantiated delegate and the Expo module, which
  forwards events to JS.
- Template ownership is native; content and playback decisions are JS:
  - Root: `CPTabBarTemplate` with four tabs — Home, Library, Artists,
    Playlists (`CPListTemplate` children only, per CarPlay rules).
  - Drill-down: `CPListTemplate` pushed per browse node; templates are
    immutable once created (no `updateSections` reliance); root is
    rebuilt wholesale on `setTabs`.
  - Playback: `CPNowPlayingTemplate.shared` pushed when a track starts
    (guarded so it is pushed once per connection).
  - Errors / sign-in gate: `CPAlertTemplate` and informational
    `CPListItem` message rows. Alert text never instructs the driver to
    handle the iPhone.
- Remote commands: play/pause/seek continue through the existing
  `MPRemoteCommandCenter` → expo-audio → engine path (ADR-009). While a
  CarPlay scene is connected, the module additionally registers
  `nextTrackCommand`/`previousTrackCommand` targets that emit bridge
  events routed to `engine.next()`/`engine.previous()`; they are removed
  on disconnect so lock-screen behavior is byte-identical to Phase 10.
  Shuffle/repeat are exposed as list rows (the `MPNowPlayingInfoCenter`
  system Now Playing UI exposes no shuffle/repeat commands).

### JS controller (`src/carplay/`)

- `CarPlayController` attaches to the native module's events and owns a
  `CarPlayContentProvider` that maps existing catalog (`listArtists`,
  `listAlbums`, `listTracks`, `listPublicPlaylists`, `getAlbum`,
  `getPlaylist`, `getArtist`…) and Library (`listLikedTracks`,
  `listHistory`, `listMyPlaylists`, `listFollowedArtists`) APIs to
  browse nodes. No new backend endpoints; private playlists stay
  server-gated (only `listMyPlaylists`/`getPlaylist`, which 404 for
  non-owners).
- Track selection always refreshes the node's track list before queueing
  (not just on cache miss), filters to `READY` status, and calls
  `engine.setQueue(tracks, index)` on the **same engine instance** the
  provider registered (`src/playback/engineRegistry.ts`) — single-player
  invariant preserved, no second HLS/session logic, no CarPlay-specific
  audio URLs. Play events, heartbeat, and telemetry are unchanged.
- The engine registry exposes `subscribeEngine` so the controller picks
  up the now-playing subscription when `PlaybackProvider` mounts after
  the CarPlay host has attached (cold-start ordering race, fixed).
- Post-`setQueue` snapshot inspection distinguishes outcomes: `locked`
  → subscription-denied alert; `error` → playback-failure alert.
- `CarPlayHost` (React) mounts inside the authenticated `PlaybackShell`,
  notifies native of auth state, and on unmount (sign-out) tells native
  to show the sign-in gate. Native holds no credentials and never sees
  tokens.
- The RN↔native bridge is five events up (`onCarPlayConnect`,
  `onCarPlayDisconnect`, `onBrowseRequest`, `onPlayRequest`,
  `onCommand`) and a handful of functions down (`setTabs`,
  `resolveBrowse`, `resolvePlay`, `updatePlayingItem`,
  `notifyAuthState`, `showAlert`, `isCarPlayConnected`). Request/response
  pairs carry a `requestId`; native applies a timeout so a dead JS side
  can never wedge CarPlay UI.

### Entitlement gating

The config plugin (`modules/waveform-carplay/app.plugin.js`) changes the
generated project **only** when explicitly enabled
(`EXPO_CARPLAY_ENABLED=1` or plugin option; default off):

- `withEntitlementsPlist`: adds `com.apple.developer.carplay-audio: true`.
- `withInfoPlist`: merges the
  `CPTemplateApplicationSceneSessionRoleApplication` scene manifest
  (`CPTemplateApplicationScene` +
  `WaveformCarplaySceneDelegate`) alongside the existing phone scene
  config.
- Always (even when disabled): verifies `UIBackgroundModes` contains
  `audio` (Phase 10 regression guard); adds nothing else — no
  microphone, no unrelated entitlements, no `UIRequiredDeviceCapabilities`.

Default builds add no CarPlay entitlement or scene manifest. The local
module's native code still compiles into the app (it is a linked
dependency) but stays inert: without the scene manifest iOS never
creates a CarPlay scene, and without the Apple-granted entitlement the
app cannot connect to real CarPlay hardware. Enabling the flag without
Apple having granted the entitlement is inert (the scene never connects)
and, at distribution time, fails code signing until the provisioning
profile includes the entitlement — which is the honest signal,
documented in `docs/CARPLAY-SETUP.md`.

## Alternatives considered

- **react-native-carplay / forks**: rejected — unmaintained or
  unverified on the new architecture/Expo SDK 57; would add a native
  dependency we cannot compile-test for marginal savings.
- **JS-driven templates** (building the whole template tree in JS):
  rejected — wider bridge, more CarPlay API surface in JS, harder to
  keep completion-handler contracts correct.
- **Duplicating playback in native code**: rejected — violates the
  single-player invariant and every Phase 8–10 guarantee.
- **CPSearchTemplate**: rejected — not available under the audio
  entitlement; Siri/Intents-extension search is future work.

## Consequences

- CarPlay browsing/playback flows through the existing engine, session
  creation, entitlement checks, and telemetry. No backend changes.
- Without the Apple-granted entitlement + a Mac/Xcode validation pass,
  CarPlay is **not production-ready**; the report distinguishes
  AUTOMATED VERIFIED from REQUIRES REAL CARPLAY/SIMULATOR TESTING.
- ~600 lines of Swift ship uncompiled (no Xcode here); they are
  deliberately written against long-stable CarPlay APIs, kept minimal,
  and covered by XCTest stubs for a future Mac run plus full JS-side
  unit tests with a mocked native module.
- New native surface to maintain: scene delegate, coordinator, bridge
  module, config plugin — all iOS-scoped and documented.
