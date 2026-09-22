# CarPlay Setup Guide (Phase 23)

Apple CarPlay integration for the Waveform mobile app. This guide covers the
Apple approval process, build configuration, and validation steps.

## What was built

A local iOS-only Expo module (`apps/mobile/modules/waveform-carplay`) that
integrates with Apple's CarPlay audio framework using real CarPlay templates
(`CPTabBarTemplate`, `CPListTemplate`, `CPNowPlayingTemplate`).

The JavaScript layer (`apps/mobile/src/carplay/`) reuses the existing
`PlaybackEngine`, queue, HLS sessions, telemetry, Now Playing, authentication,
and server-authoritative subscription enforcement. CarPlay is a remote control
for the one player — not a second player.

## Apple approval requirements

**CarPlay audio requires explicit approval from Apple.** This is not automatic.

### 1. Request CarPlay entitlement

1. Go to https://developer.apple.com/contact/carplay/
2. Submit a request for the CarPlay audio app entitlement
3. Provide your app's Bundle ID, description, and use case
4. Wait for Apple approval (timeline varies; can take days to weeks)

### 2. Enable the capability in your App ID

After Apple approves your request:

1. Go to Apple Developer Portal → Certificates, Identifiers & Profiles
2. Select your App ID (e.g., `com.musicstreaming.waveform`)
3. Enable the **CarPlay Audio** capability
4. Save changes

### 3. Regenerate provisioning profiles

1. Delete or regenerate all provisioning profiles for the App ID
2. Download the new profiles (they now include the CarPlay entitlement)
3. Install in Xcode or your CI system

### 4. Build with the CarPlay flag

The CarPlay entitlement and scene manifest are **opt-in** via build flag:

```bash
# Enable CarPlay in the prebuild
EXPO_CARPLAY_ENABLED=1 npx expo prebuild --clean

# Or via plugin options in app.json:
# ["./modules/waveform-carplay/app.plugin.js", { "enabled": true }]
```

**Default (flag unset):** No CarPlay entitlement or scene manifest is added.
The native module compiles in but stays inert — iOS never creates a CarPlay
scene without the manifest, and the app cannot connect to CarPlay hardware
without the Apple-granted entitlement.

## Development build requirements

CarPlay requires a **development build** (not Expo Go):

```bash
# iOS development build
npx expo run:ios --device

# Or build via EAS
eas build --profile development --platform ios
```

The local native module (`waveform-carplay`) requires compilation — it cannot
work in Expo Go.

## Testing

### Simulator

1. Open Xcode → Device and Simulator window
2. Add a CarPlay simulator (Window → Devices and Simulators → Simulators)
3. Run the app on an iPhone simulator
4. In the CarPlay simulator, your app should appear if the entitlement is
   properly provisioned

**Note:** The CarPlay simulator requires the entitlement to be in your
provisioning profile. Without Apple approval, the scene will not connect.

### Real vehicle / CarPlay head unit

1. Install the development build on a physical iPhone
2. Connect to a CarPlay-enabled vehicle or head unit (wired or wireless)
3. The Waveform app should appear in the CarPlay interface
4. Test: browse tabs, play tracks, use transport controls, verify Now Playing

### What to verify

- [ ] Four tabs appear: Home, Library, Artists, Playlists
- [ ] Browsing shows real catalog content (not placeholders)
- [ ] Tapping a track plays through the existing engine (check phone app
      shows same queue/now-playing)
- [ ] Play/pause/next/previous work from CarPlay
- [ ] Shuffle/repeat toggles update Library tab subtitles
- [ ] Now Playing template shows current track
- [ ] Signed-out state shows sign-in gate (no private data)
- [ ] Inactive subscription shows "Subscription required" (not a crash)
- [ ] Airplane mode / no network shows safe error (not a hang)

## Disabled fallback

If CarPlay is not enabled (default):

- The app builds and runs normally on iPhone
- No CarPlay scene is registered
- No entitlement is requested
- Background audio (Phase 10) continues to work
- Android is completely unaffected (no manifest changes)

## Architecture notes

See `docs/adr/017-carplay-integration.md` for the full architecture decision.

Key principles:
- **Native owns templates:** Swift code creates and manages all CarPlay UI
- **JS supplies content:** The controller answers browse/play requests with
  data from the existing catalog APIs
- **One player:** All playback goes through the shared `PlaybackEngine`
- **Server authoritative:** Subscription checks, entitlements, and content
  authorization happen server-side; the client only displays what the
  server allows
- **Signed-out safety:** No private data is exposed when signed out

## Troubleshooting

### CarPlay scene never connects

- Verify Apple has approved your CarPlay entitlement request
- Check the App ID has CarPlay Audio capability enabled
- Regenerate provisioning profiles after enabling the capability
- Confirm `EXPO_CARPLAY_ENABLED=1` was set during prebuild
- Check the built Info.plist contains the CarPlay scene manifest
- Check the .entitlements file contains `com.apple.developer.carplay-audio`

### App appears in CarPlay but shows no content

- Verify the user is signed in (check `notifyAuthState` is called)
- Check network connectivity (the controller fetches from the API)
- Look for `resolveBrowse` errors in the native logs

### Playback doesn't start from CarPlay

- Verify the shared engine is registered (check `PlaybackProvider` mounted)
- Check the track is READY status (not TAKEDOWN/deleted)
- Verify the subscription is active (server returns 403 for inactive)
- Check HLS session creation succeeds (network, auth token valid)
