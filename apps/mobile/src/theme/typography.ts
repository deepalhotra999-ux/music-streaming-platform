// Phase 5 — design system: typography scale.
// System font stack; sizes and weights referenced by name.

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  hero: 40,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const lineHeight = {
  tight: 1.15,
  normal: 1.4,
  relaxed: 1.6,
} as const;

export type FontSizeName = keyof typeof fontSize;
export type FontWeightName = keyof typeof fontWeight;
