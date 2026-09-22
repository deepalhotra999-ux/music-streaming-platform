// Phase 21 — Royalty Engine. Money arithmetic in integer minor units.
//
// All royalty calculations use BigInt minor units (e.g., cents) to avoid
// JavaScript floating-point arithmetic entirely. Database NUMERIC(19,4)
// values are converted to minor units on read and back on write.
//
// Conventions:
// - Minor units are always BigInt.
// - Major-unit strings from the DB (NUMERIC) are parsed exactly.
// - Rounding is explicit: HALF_UP (ties away from zero for positives).

/** Number of decimal places in the minor unit (cents = 2). */
export const MINOR_UNIT_DIGITS = 2;

/**
 * Parse a major-unit decimal string (e.g., "1234.56", "100", "0.1") into
 * minor units (BigInt). Rejects malformed input. No floating point.
 */
export function toMinorUnits(major: string | number): bigint {
  const s = typeof major === 'number' ? major.toString() : major.trim();
  if (!/^-?\d+(\.\d{1,4})?$/.test(s)) {
    throw new Error(`Invalid monetary amount: ${major}`);
  }
  const negative = s.startsWith('-');
  const digits = negative ? s.slice(1) : s;
  const [whole, frac = ''] = digits.split('.');
  // Pad/truncate fraction to minor-unit digits with HALF_UP rounding.
  const padded = (frac + '0000').slice(0, 4); // up to 4 dp from NUMERIC(19,4)
  const fracMinor = padded.slice(0, MINOR_UNIT_DIGITS);
  const remainder = padded.slice(MINOR_UNIT_DIGITS);
  let minor = BigInt(whole) * 100n + BigInt(fracMinor || '0');
  // Round half up on the discarded digits: the discarded fraction is
  // remainder / 10^len, which is >= 0.5 iff its first digit >= 5.
  if (remainder.length > 0 && remainder[0] >= '5') {
    minor += 1n;
  }
  return negative ? -minor : minor;
}

/**
 * Format minor units (BigInt) as a major-unit decimal string with exactly
 * 2 decimal places (e.g., 123456n -> "1234.56").
 */
export function fromMinorUnits(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * Format minor units as a 4-decimal string for NUMERIC(19,4) storage
 * (e.g., 123456n -> "1234.5600").
 */
export function toNumericString(minor: bigint): string {
  return `${fromMinorUnits(minor)}00`;
}

/**
 * Round-half-up division: round(a / b) to the nearest integer, ties up.
 * Used for per-line allocation: round(pool * streams / total).
 */
export function divRoundHalfUp(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('Division by non-positive divisor');
  const q = a / b;
  const r = a % b;
  // r * 2 >= b  <=>  fractional part >= 0.5
  return r * 2n >= b ? q + 1n : q;
}

/**
 * Calculate a percentage of an amount in minor units, rounded half up.
 * pct is a percentage like 70.00 (as a string to avoid float).
 * E.g., pctOf(10000n, "70") = 7000n.
 */
export function pctOf(amountMinor: bigint, pctMajor: string): bigint {
  // Parse pct as basis points * 100 (e.g., "70.25" -> 702500n representing 70.25%)
  const s = pctMajor.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(s)) {
    throw new Error(`Invalid percentage: ${pctMajor}`);
  }
  const [whole, frac = ''] = s.split('.');
  const pctBp = BigInt(whole) * 10000n + BigInt((frac + '0000').slice(0, 4));
  // amount * pct / 100, rounded half up = (amount * pctBp + 500000) / 1000000
  // Using divRoundHalfUp: (amount * pctBp) / 1_000_000
  return divRoundHalfUp(amountMinor * pctBp, 1_000_000n);
}
