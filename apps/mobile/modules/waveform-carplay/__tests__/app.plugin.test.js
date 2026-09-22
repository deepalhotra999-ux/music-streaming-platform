// Phase 23 — config plugin unit tests (plain Jest, no Expo CLI needed).
//
// jest.mock replaces @expo/config-plugins so we can capture the with*
// callbacks the plugin registers and run them against a synthetic config.
// Pins:
//  - disabled by default: project unchanged (no entitlement, no scene),
//  - enabled via env flag: entitlement + CarPlay scene manifest, merged
//    alongside the existing iPhone scene config,
//  - background audio mode preserved in both cases (Phase 10 guard),
//  - no other entitlements/permissions ever added.

const mockHandlers = {};

jest.mock('@expo/config-plugins', () => ({
  withEntitlementsPlist: (config, fn) => {
    mockHandlers.entitlements = fn;
    return config;
  },
  withInfoPlist: (config, fn) => {
    mockHandlers.info = fn;
    return config;
  },
}));

// The plugin is plain CommonJS tooling (the eslint config disables the
// require-imports rule for this test path).
const plugin = require('../app.plugin.js');

const BASE_CONFIG = {
  ios: {
    infoPlist: {
      UIBackgroundModes: ['audio'],
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            { UISceneConfigurationName: 'Default', UISceneDelegateClassName: 'SceneDelegate' },
          ],
        },
      },
    },
    entitlements: {},
  },
};

const ENTITLEMENT = 'com.apple.developer.carplay-audio';

function run(config, options, envValue) {
  const previous = process.env.EXPO_CARPLAY_ENABLED;
  if (envValue === undefined) {
    delete process.env.EXPO_CARPLAY_ENABLED;
  } else {
    process.env.EXPO_CARPLAY_ENABLED = envValue;
  }
  try {
    plugin(config, options);
    return {
      info: mockHandlers.info({ modResults: structuredClone(config.ios.infoPlist) }).modResults,
      entitlements: mockHandlers.entitlements
        ? mockHandlers.entitlements({ modResults: structuredClone(config.ios.entitlements) })
            .modResults
        : null,
    };
  } finally {
    if (previous === undefined) {
      delete process.env.EXPO_CARPLAY_ENABLED;
    } else {
      process.env.EXPO_CARPLAY_ENABLED = previous;
    }
  }
}

describe('waveform-carplay config plugin', () => {
  test('disabled by default: no entitlement, no CarPlay scene, audio mode kept', () => {
    const { info, entitlements } = run(structuredClone(BASE_CONFIG), {});

    expect(entitlements).toBeNull();
    const scenes = info.UIApplicationSceneManifest.UISceneConfigurations;
    expect(scenes).not.toHaveProperty('CPTemplateApplicationSceneSessionRoleApplication');
    // Existing iPhone scene config untouched.
    expect(scenes.UIWindowSceneSessionRoleApplication).toHaveLength(1);
    expect(info.UIBackgroundModes).toEqual(['audio']);
  });

  test('EXPO_CARPLAY_ENABLED=1 adds the entitlement and merges the scene manifest', () => {
    const { info, entitlements } = run(structuredClone(BASE_CONFIG), {}, '1');

    expect(entitlements[ENTITLEMENT]).toBe(true);
    // Only this entitlement — nothing else (no mic, no unrelated keys).
    expect(Object.keys(entitlements)).toEqual([ENTITLEMENT]);

    const scenes = info.UIApplicationSceneManifest.UISceneConfigurations;
    const carplay = scenes.CPTemplateApplicationSceneSessionRoleApplication;
    expect(carplay).toHaveLength(1);
    expect(carplay[0]).toMatchObject({
      UISceneConfigurationName: 'WaveformCarPlay',
      UISceneDelegateClassName: 'WaveformCarplaySceneDelegate',
      UISceneClassName: 'CPTemplateApplicationScene',
    });
    // Existing iPhone scene config preserved alongside.
    expect(scenes.UIWindowSceneSessionRoleApplication).toHaveLength(1);
    expect(info.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes).toBe(true);
    expect(info.UIBackgroundModes).toContain('audio');
  });

  test('plugin option { enabled: true } also enables', () => {
    const { entitlements } = run(structuredClone(BASE_CONFIG), { enabled: true });
    expect(entitlements[ENTITLEMENT]).toBe(true);
  });

  test('restores the audio background mode if a project lost it', () => {
    const config = structuredClone(BASE_CONFIG);
    config.ios.infoPlist.UIBackgroundModes = ['fetch'];
    const { info } = run(config, {});
    expect(info.UIBackgroundModes).toEqual(expect.arrayContaining(['audio', 'fetch']));
  });
});
