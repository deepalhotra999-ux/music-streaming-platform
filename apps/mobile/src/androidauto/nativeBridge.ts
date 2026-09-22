// Phase 24 — safe access to the WaveformAndroidAuto native module.
//
// The module is Android-only and only linked when the local Expo module is
// installed. Everywhere else (iOS, Expo Go, Jest, an Android build without
// the module) this resolves to null and the app behaves exactly as before
// — the bridge is capability-gated, never assumed.

import { Platform } from 'react-native';

/** The typed WaveformAndroidAuto native module instance. */
export type AndroidAutoNativeModule = typeof import('waveform-android-auto').default;

let cached: AndroidAutoNativeModule | null | undefined;

/** The native Android Auto module, or null when unavailable on this platform/build. */
export function getAndroidAutoNativeModule(): AndroidAutoNativeModule | null {
  if (cached !== undefined) {
    return cached;
  }
  if (Platform.OS !== 'android') {
    cached = null;
    return cached;
  }
  try {
    // The Jest mock and any other test double replace this module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('waveform-android-auto').default as
      AndroidAutoNativeModule | null | undefined;
    cached = mod ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Test-only: reset the cached lookup. */
export function resetAndroidAutoNativeModuleCache(): void {
  cached = undefined;
}
