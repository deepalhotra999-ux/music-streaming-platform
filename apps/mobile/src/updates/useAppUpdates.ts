// Release tooling — over-the-air (OTA) updates via expo-updates.
//
// What this does: on launch (and when the app returns to the foreground) the
// app asks the EAS Update server whether a newer JS bundle exists for this
// runtime version + channel. If one exists it is downloaded in the background
// and applied on the next restart — no App Store / Play Store round-trip.
//
// Hard limits (do not "fix" these in JS):
// - OTA covers JavaScript and assets only. Native changes (new native
//   modules, SDK upgrades, permissions, app.json native keys) still require
//   a store build with a bumped runtimeVersion.
// - Updates only apply to builds whose runtimeVersion matches. A build whose
//   native code changed will never receive an older-runtime update.
// - In development (Expo Go / `expo start`) Updates.isEnabled is false and
//   the hook reports 'unavailable' — that is expected, not an error.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as Updates from 'expo-updates';

export type UpdateCheckState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'ready' // downloaded, restart to apply
  | 'up-to-date'
  | 'error'
  | 'unavailable'; // Updates.isEnabled === false (dev / Expo Go)

export interface UpdateInfo {
  channel: string | null;
  /** Short display form of the update id (first 8 chars), null when embedded. */
  updateId: string | null;
  runtimeVersion: string | null;
  createdAt: Date | null;
  isEmbeddedLaunch: boolean;
}

/** Minimum gap between automatic foreground checks. Manual checks ignore it. */
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;

function readInfo(): UpdateInfo {
  return {
    channel: Updates.channel ?? null,
    updateId: Updates.updateId ?? null,
    runtimeVersion: Updates.runtimeVersion ?? null,
    createdAt: Updates.createdAt ?? null,
    isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  };
}

export interface AppUpdates {
  state: UpdateCheckState;
  error: string | null;
  info: UpdateInfo;
  /** Manual check; safe to call any time. No-ops while a check is in flight. */
  checkNow: () => Promise<void>;
  /** Applies a downloaded update by restarting the JS runtime. */
  applyUpdate: () => Promise<void>;
}

export function useAppUpdates(): AppUpdates {
  const [state, setState] = useState<UpdateCheckState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [info] = useState<UpdateInfo>(readInfo);
  const busyRef = useRef(false);
  const lastAutoCheckRef = useRef(0);

  const runCheck = useCallback(async () => {
    if (busyRef.current) return;
    if (!Updates.isEnabled) {
      setState('unavailable');
      return;
    }
    busyRef.current = true;
    setError(null);
    setState('checking');
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        setState('up-to-date');
        return;
      }
      setState('downloading');
      await Updates.fetchUpdateAsync();
      setState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update check failed.');
      setState('error');
    } finally {
      busyRef.current = false;
    }
  }, []);

  const checkNow = useCallback(async () => {
    await runCheck();
  }, [runCheck]);

  // Automatic checks: once on mount, then on foreground transitions no more
  // often than AUTO_CHECK_INTERVAL_MS. Manual checks are always allowed.
  useEffect(() => {
    if (!Updates.isEnabled) {
      setState('unavailable');
      return;
    }
    lastAutoCheckRef.current = Date.now();
    void runCheck();
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active' && Date.now() - lastAutoCheckRef.current >= AUTO_CHECK_INTERVAL_MS) {
        lastAutoCheckRef.current = Date.now();
        void runCheck();
      }
    });
    return () => sub.remove();
  }, [runCheck]);

  const applyUpdate = useCallback(async () => {
    await Updates.reloadAsync();
  }, []);

  return { state, error, info, checkNow, applyUpdate };
}
