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
  textFaint: '#6E6E80',

  // Brand
  primary: '#7C5CFF',
  primaryPressed: '#6847F2',
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
