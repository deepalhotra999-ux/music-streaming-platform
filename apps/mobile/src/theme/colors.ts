// Phase 5 — design system: color tokens.
// Dark-first palette for a music product. Semantic names only; no raw hex
// outside this file.

export const colors = {
  // Surfaces
  background: '#0B0B0F',
  surface: '#15151C',
  surfaceElevated: '#1E1E28',
  border: '#2A2A35',

  // Text
  text: '#FFFFFF',
  textMuted: '#A8A8B8',
  // Phase 31 — lightened from #6E6E80 (3.9:1) to meet WCAG AA 4.5:1
  // for secondary text and placeholders on the background.
  textFaint: '#8E8EA0',

  // Brand
  primary: '#7C5CFF',
  primaryPressed: '#6847F2',
  // Phase 31 — filled-button background. White text on `primary` is 4.35:1
  // (just under AA); on `primaryFilled` it is 5.5:1. `primary` remains for
  // text, links, and icons on dark surfaces (4.52:1).
  primaryFilled: '#6A48F0',
  primaryFilledPressed: '#5A3CE0',
  onPrimary: '#FFFFFF',

  // Secondary / ghost actions
  secondary: '#23232E',
  secondaryPressed: '#2C2C3A',

  // Feedback
  error: '#FF6B6B',
  errorMuted: '#3A2126',
  success: '#3DDC97',
  warning: '#FFC857',

  // Tab bar / overlays
  tabBar: '#101016',
  overlay: 'rgba(0, 0, 0, 0.6)',
} as const;

export type ColorName = keyof typeof colors;
