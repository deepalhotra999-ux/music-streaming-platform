// Phase 23 — Expo config plugin for Apple CarPlay (audio).
//
// What it does (only when explicitly enabled):
//  1. Adds the `com.apple.developer.carplay-audio` entitlement.
//  2. Merges the CarPlay scene manifest
//     (CPTemplateApplicationSceneSessionRoleApplication) into Info.plist
//     alongside the existing iPhone scene configuration.
//
// What it always does:
//  - Verifies the `audio` UIBackgroundMode (Phase 10) is present; adds it
//    if some other plugin removed it. Never removes anything.
//
// Enabling:
//   EXPO_CARPLAY_ENABLED=1 npx expo prebuild
// or via plugin options: ["./modules/waveform-carplay/app.plugin.js", { enabled: true }]
//
// Default (flag unset): no CarPlay entitlement and no CarPlay scene
// manifest are added. The local module's native code still compiles into
// the app (it is a linked dependency) but stays inert: without the scene
// manifest iOS never creates a CarPlay scene, and without the Apple grant
// the app cannot connect to real CarPlay hardware. (The guard below that
// preserves the Phase 10 background-audio mode still runs on every
// prebuild.) This is deliberate: the CarPlay audio entitlement must be
// granted by Apple per Developer team (request at
// https://developer.apple.com/contact/carplay/) and baked into the
// provisioning profile; enabling the flag without that grant is inert
// (the scene never connects) and fails code signing at distribution
// time. See docs/CARPLAY-SETUP.md.
//
// This plugin adds NO other entitlements, NO microphone capability, NO
// Android manifest changes, and NO UIRequiredDeviceCapabilities.

const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

const CARPLAY_AUDIO_ENTITLEMENT = 'com.apple.developer.carplay-audio';
const CARPLAY_SCENE_ROLE = 'CPTemplateApplicationSceneSessionRoleApplication';
// @objc name of the Swift scene delegate in the WaveformCarplay module.
const CARPLAY_SCENE_DELEGATE = 'WaveformCarplaySceneDelegate';

function isEnabled(options) {
  if (options && typeof options.enabled === 'boolean') {
    return options.enabled;
  }
  return process.env.EXPO_CARPLAY_ENABLED === '1';
}

function withWaveformCarPlay(config, options = {}) {
  const enabled = isEnabled(options);

  config = withInfoPlist(config, (config) => {
    // Phase 10 regression guard: background audio must survive prebuild.
    // Runs on every prebuild, even with the CarPlay flag off.
    const modes = config.modResults.UIBackgroundModes || [];
    if (!modes.includes('audio')) {
      config.modResults.UIBackgroundModes = [...modes, 'audio'];
    }

    if (enabled) {
      const manifest = config.modResults.UIApplicationSceneManifest || {};
      const sceneConfigs = { ...(manifest.UISceneConfigurations || {}) };
      // Merge — never replace the existing iPhone scene configuration.
      sceneConfigs[CARPLAY_SCENE_ROLE] = [
        {
          UISceneConfigurationName: 'WaveformCarPlay',
          UISceneDelegateClassName: CARPLAY_SCENE_DELEGATE,
          UISceneClassName: 'CPTemplateApplicationScene',
        },
      ];
      config.modResults.UIApplicationSceneManifest = {
        ...manifest,
        UIApplicationSupportsMultipleScenes: true,
        UISceneConfigurations: sceneConfigs,
      };
    }
    return config;
  });

  if (enabled) {
    config = withEntitlementsPlist(config, (config) => {
      config.modResults[CARPLAY_AUDIO_ENTITLEMENT] = true;
      return config;
    });
  }
  return config;
}

module.exports = withWaveformCarPlay;
