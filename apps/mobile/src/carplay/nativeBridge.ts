// Phase 23 — safe access to the WaveformCarplay native module.
//
// The module is iOS-only and only linked when the local Expo module is
// installed. Everywhere else (Android, Expo Go, Jest, an iOS build
// without the module) this resolves to null and the app behaves exactly
// as before — the bridge is capability-gated, never assumed.

import { Platform } from 'react-native';

/** The typed WaveformCarplay native module instance. */
export type CarPlayNativeModule = typeof import('waveform-carplay').default;

let cached: CarPlayNativeModule | null | undefined;

/** The native CarPlay module, or null when unavailable on this platform/build. */
export function getCarPlayNativeModule(): CarPlayNativeModule | null {
  if (cached !== undefined) {
    return cached;
  }
  if (Platform.OS !== 'ios') {
    cached = null;
    return cached;
  }
  try {
    // The Jest mock and any other test double replace this module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('waveform-carplay').default as CarPlayNativeModule | null | undefined;
    cached = mod ?? null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Test-only: reset the cached lookup. */
export function resetCarPlayNativeModuleCache(): void {
  cached = undefined;
}
