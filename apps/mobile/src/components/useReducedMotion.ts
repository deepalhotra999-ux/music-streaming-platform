// Phase 31 — reduced-motion support.
//
// Wraps React Native's AccessibilityInfo so components can disable or
// simplify motion (modal transitions, animated feedback) when the user
// prefers reduced motion.

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** True when the OS reports the user prefers reduced motion. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((value) => {
        if (mounted) setReduced(value);
      })
      .catch(() => {
        /* unavailable — keep default */
      });
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      sub?.remove();
    };
  }, []);

  return reduced;
}

/**
 * Modal animation type honoring the reduced-motion preference.
 * Pass the component's normal animation; returns 'none' when reduced motion
 * is preferred.
 */
export function modalAnimationFor(
  reducedMotion: boolean,
  normal: 'slide' | 'fade' | 'none' = 'slide',
): 'slide' | 'fade' | 'none' {
  return reducedMotion ? 'none' : normal;
}
