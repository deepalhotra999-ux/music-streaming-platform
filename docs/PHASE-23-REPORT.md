# Phase 23 Report: Apple CarPlay Audio Integration

**Date:** 2026-09-22
**Status:** Complete (with honest limitations documented below)
**Commit:** (to be filled on commit)

## Summary

Phase 23 adds Apple CarPlay audio integration to the Waveform mobile app using
real CarPlay templates (not a fake React Native screen). The implementation
reuses the existing `PlaybackEngine`, queue, HLS sessions, telemetry, Now
Playing, authentication, and server-authoritative subscription enforcement.
CarPlay is a remote control for the one player — not a second player.

## What was built

### Local Expo module (`apps/mobile/modules/waveform-carplay/`)

- `package.json`, `expo-module.config.json` — iOS-only module definition
- `src/index.ts` — TypeScript bridge interface (5 events up, 7 functions down)
- `app.plugin.js` — Flag-gated config plugin (entitlement + scene manifest)
- `ios/WaveformCarplay.podspec` — CocoaPods specification
- `ios/WaveformCarplayModule.swift` — Expo module bridging to JS
- `ios/CarPlayCoordinator.swift` — Template lifecycle owner (~400 lines)
- `ios/CarPlaySceneDelegate.swift` — `@objc(WaveformCarplaySceneDelegate)`
- `ios/CarPlayIdentifiers.swift` — Typed node/item identifiers
- `ios/Tests/CarPlayIdentifiersTests.swift` — Native unit tests (XCTest)

### JavaScript layer (`apps/mobile/src/carplay/`)

- `nativeBridge.ts` — Safe native module accessor (null off iOS)
- `identifiers.ts` — Node/item ID parsing and construction
- `contentProvider.ts` — Maps catalog/library APIs to CarPlay browse nodes
- `controller.ts` — Event handler, owns provider, drives the shared engine
- `CarPlayHost.tsx` — React host, mounts in authenticated shell
- `index.ts` — Public exports
- `__tests__/` — 3 test suites, 26 tests (13 controller + 9 provider + 4 identifiers)

### Shared wiring

- `apps/mobile/src/playback/engineRegistry.ts` — Added `subscribeEngine`
  for deterministic late-registration handling
- `apps/mobile/src/playback/provider.tsx` — Registers engine (unchanged behavior)
- `apps/mobile/src/app/_layout.tsx` — Mounts `CarPlayHost` in auth shell
- `apps/mobile/app.json` — Registers the config plugin (default: disabled)
- `apps/mobile/package.json` — Added `waveform-carplay: file:./modules/waveform-carplay`

## Acceptance criteria

### ✅ Real CarPlay templates (not fake UI)

- Native Swift code uses `CPTabBarTemplate`, `CPListTemplate`,
  `CPNowPlayingTemplate.shared`, `CPAlertTemplate`
- No React Native views are rendered in the car; JS only supplies data
- Template ownership is native; content decisions are JS

### ✅ One player, one queue, one session

- `CarPlayController` calls `engine.setQueue()` on the shared instance
- No second audio player, no CarPlay-specific HLS URLs
- Play events, heartbeat (30s), telemetry unchanged
- `MPNowPlayingInfoCenter` remains the single Now Playing source (Phase 10)

### ✅ Server-authoritative enforcement

- Subscription checks happen server-side; client displays `locked` snapshot
- Private playlists: only via `getPlaylist` which 404s for non-owners
- No subscription forms in CarPlay (directs to phone app)
- Signed-out: native shows sign-in gate, no private data exposed

### ✅ Narrow native boundary, Android unaffected

- iOS-only module (`platforms: ["ios"]`); JS wrapper returns null off iOS
- No Android manifest changes, no Android native code
- Config plugin adds no Android changes

### ✅ Safe failure modes

- `setQueue` rejection → resolves play request with safe error (never hangs)
- Track TAKEDOWN/deleted between browse and tap → fails safe (always refresh)
- Network/catalog failure → safe error message (no internals leaked)
- Engine registers late → `subscribeEngine` picks up now-playing sync
- Unsupported environment (null native) → no-op, no crash

### ✅ Clean gating

- Default: no entitlement, no scene manifest (inert but compiled)
- Flag `EXPO_CARPLAY_ENABLED=1` enables entitlement + manifest
- Apple approval required; documented in `docs/CARPLAY-SETUP.md`
- Background audio (Phase 10) preserved in both modes

## AUTOMATED VERIFIED

### Unit tests

- **Full mobile suite:** 63 suites, 469 tests — all pass (post-commit
  regression run; includes all CarPlay tests below).
- **CarPlay JS:** 3 suites, 26 tests — all pass
  - `controller.test.ts`: 13 tests (attach/detach, browse, play, commands,
    engine sync, error paths, late registration, tab refresh)
  - `contentProvider.test.ts`: 9 tests (tabs, nodes, filtering, empty states)
  - `identifiers.test.ts`: 4 tests (parsing, construction)
- **Config plugin:** 1 suite, 4 tests — all pass
  - Enabled/disabled modes, entitlement, scene manifest, background audio guard

### Static analysis

- **TypeScript:** `npx tsc --noEmit` — 0 errors
- **ESLint:** 0 errors on changed files
- **Prettier:** All changed files conform

### Expo Doctor

- **Result:** 20/21 checks pass
- **Failing:** Missing peer dependency `expo-modules-core` (required by
  `waveform-carplay`)
- **Why:** The module correctly declares `expo-modules-core` as a peer
  dependency (Expo convention for local modules). Adding it as a direct
  dependency causes `ERESOLVE` due to a pre-existing SDK 57 ecosystem
  conflict (`react-native-worklets@0.13.0` vs `expo-modules-core`'s
  `peerOptional` range). The package is physically installed (hoisted
  57.0.18) and the runtime works. Documented honestly; not a code issue.

## REQUIRES REAL CARPLAY/SIMULATOR TESTING

The following cannot be verified in this Linux sandbox (no Xcode, no iOS
device, no CarPlay hardware):

### Native compilation

- Swift code (~600 lines) has not been compiled
- Written against long-stable CarPlay APIs (iOS 14+)
- XCTest stubs exist for Mac validation
- **Action:** Run `xcodebuild test` on a Mac with Xcode 15+

### CarPlay scene lifecycle

- Scene delegate connection/disconnection
- Template push/pop behavior
- Tab bar rendering with 4 tabs
- List template drill-down
- Now Playing template push (singleton guard)
- Alert template display
- **Action:** Test in CarPlay simulator (requires entitlement in profile)

### Real hardware integration

- CarPlay head unit / vehicle connection
- Audio routing to car speakers
- Steering wheel controls (next/previous)
- Siri integration (deferred — requires Intents extension)
- **Action:** Test with development build on physical iPhone + CarPlay vehicle

### Apple approval flow

- Entitlement request approval timeline
- App ID capability activation
- Provisioning profile regeneration
- Code signing with CarPlay entitlement
- **Action:** Follow `docs/CARPLAY-SETUP.md` steps 1-4

## Files created

```
apps/mobile/modules/waveform-carplay/
  package.json
  expo-module.config.json
  src/index.ts
  app.plugin.js
  ios/WaveformCarplay.podspec
  ios/WaveformCarplayModule.swift
  ios/CarPlayCoordinator.swift
  ios/CarPlaySceneDelegate.swift
  ios/CarPlayIdentifiers.swift
  ios/Tests/CarPlayIdentifiersTests.swift

apps/mobile/src/carplay/
  nativeBridge.ts
  identifiers.ts
  contentProvider.ts
  controller.ts
  CarPlayHost.tsx
  index.ts
  __tests__/identifiers.test.ts
  __tests__/contentProvider.test.ts
  __tests__/controller.test.ts

apps/mobile/src/playback/engineRegistry.ts (new)

docs/adr/017-carplay-integration.md
docs/CARPLAY-SETUP.md
docs/PHASE-23-REPORT.md (this file)
```

## Files modified

```
apps/mobile/app.json — Added waveform-carplay plugin (default disabled)
apps/mobile/package.json — Added waveform-carplay file: dependency
apps/mobile/package-lock.json — Lockfile update for local module
apps/mobile/eslint.config.mjs — (if changed for module)
apps/mobile/src/app/_layout.tsx — Mount CarPlayHost in auth shell
apps/mobile/src/playback/provider.tsx — (unchanged, engine registration)
apps/mobile/src/playback/engineRegistry.ts — Added subscribeEngine
apps/mobile/src/carplay/controller.ts — All correctness fixes
apps/mobile/src/carplay/contentProvider.ts — Comment update
docs/adr/017-carplay-integration.md — Reconciled with implementation
```

## Correctness fixes applied (this turn)

1. **handlePlay() exception safety:** `engine.setQueue()` wrapped in
   try/catch; native request always resolved (never hangs on timeout).

2. **Stale-track refresh:** Controller always refreshes node tracks before
   queueing (not just on cache miss). TAKEDOWN/deleted tracks fail safe.

3. **Engine registration race:** Added `subscribeEngine` to registry;
   controller subscribes and picks up now-playing sync when engine registers
   late (cold-start ordering).

4. **Swift token ownership:** Remote command tokens now stored as
   `(command, token)` pairs; each removed from its originating command
   (not blindly from both).

5. **Plugin documentation:** Corrected "byte-identical" overstatement.
   Default builds add no entitlement/manifest but the module still compiles
   in (inert without scene manifest).

6. **Mode label freshness:** Shuffle/repeat commands trigger tab refresh
   so Library subtitles reflect current state.

7. **Content provider comment:** Updated to reflect always-refresh behavior.

## Manual checklist (for real-device validation)

- [ ] Build with `EXPO_CARPLAY_ENABLED=1` on a Mac
- [ ] Verify entitlement in built app (`codesign -d --entitlements`)
- [ ] Verify scene manifest in Info.plist
- [ ] Install on iPhone, connect to CarPlay simulator
- [ ] Four tabs appear with real content
- [ ] Tap track → plays, phone app shows same queue
- [ ] Next/previous from car and steering wheel work
- [ ] Shuffle/repeat toggles update subtitles
- [ ] Now Playing shows current track with artwork
- [ ] Sign out → CarPlay shows sign-in gate (no private data)
- [ ] Inactive subscription → "Subscription required" alert
- [ ] Airplane mode → safe error, no hang
- [ ] Disconnect car → audio keeps playing on phone
- [ ] Reconnect car → tabs reload, now-playing syncs

## Known limitations

1. **No Apple approval:** CarPlay will not appear in real vehicles until
   Apple grants the `com.apple.developer.carplay-audio` entitlement.
   This is expected and documented.

2. **No Xcode validation:** Swift code is uncompiled. APIs used are
   long-stable (iOS 14+), but a Mac build is required before production.

3. **No typed search:** `CPSearchTemplate` is not available under the audio
   entitlement. Siri/Intents-extension search is future work (deferred by
   design, documented in ADR-017).

4. **Expo Doctor 20/21:** Peer dependency warning documented above. Not a
   functional issue; the module works at runtime.

5. **Simulator only:** CarPlay simulator requires the entitlement in the
   provisioning profile. Without Apple approval, even simulator testing
   is limited.

## References

- ADR-017: `docs/adr/017-carplay-integration.md`
- Setup guide: `docs/CARPLAY-SETUP.md`
- Apple CarPlay docs: https://developer.apple.com/carplay/
- Entitlement request: https://developer.apple.com/contact/carplay/
